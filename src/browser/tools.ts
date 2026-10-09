/**
 * Browser tools for agents: the engine behind bin/rooms-browser. Every harness has a shell, so agents drive the shared
 * browsers with a command line instead of harness-specific MCP configuration.
 *
 * Several agents work in one browser at once, each in its own tabs, without waiting for each other (B2):
 * - Each agent has an engine of its own on each browser it uses: a chrome-devtools-mcp (stdio MCP server) attached to
 *   the browser's DevTools port with --pageIdRouting, so every page command names its tab. An engine runs its calls
 *   one at a time, so an agent's calls wait only for its own. An engine unused for ENGINE_IDLE_MS closes.
 * - Every tab an agent opens gets a window of its own. Chrome draws only the tab in front of each window; the engine
 *   emulates a focused page on every tab, so a tab behind another still runs, holds the focus and shows focus rings,
 *   but its timers run about once a second and a screenshot of it can hang. In a window of its own, an agent's tab is
 *   always in front.
 * - Tabs have one number per running browser, the same for every agent (engines number pages each in their own
 *   order; Chrome's tab id, from the engine's get_tab_id, ties them together). A tab belongs to the agent that opened
 *   it (its key from the briefing, "sol1.2fa05e45"); acting on another tab needs --force. Owners live with the running
 *   browser: when it restarts, its restored tabs belong to nobody.
 *
 * The command line is parsed here, not in the CLI, so help, rules and tool mapping have one home.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Browser } from "../domain/types.ts";
import type { BrowserAccess } from "./catalog.ts";
import type { RoomBrowsers } from "./roomBrowsers.ts";

const ENGINE_BIN = createRequire(import.meta.url).resolve("chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js");
const ENGINE_ARGS = [
  "--pageIdRouting",
  // get_tab_id: Chrome's id of a page's tab, the same in every engine.
  "--experimentalInteropTools",
  // Nothing leaves the machine: no usage statistics, no CrUX lookups; performance, memory and emulation tools are off.
  "--usageStatistics=false",
  "--performanceCrux=false",
  "--categoryPerformance=false",
  "--categoryMemory=false",
  "--categoryEmulation=false",
];
const CALL_TIMEOUT_MS = 90_000;
const ENGINE_IDLE_MS = 10 * 60_000;
/** A new tab's address until its engine has found it: about:blank with a fragment no other tab has. */
const NEW_TAB = "about:blank#rooms-browser-";
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

/** What the tools need of an engine: MCP tool calls, run one at a time. Tests give a fake. */
export interface ToolEngine {
  readonly closed: boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): void;
}

/** A chrome-devtools-mcp process attached to one running browser, for one agent. */
class Engine implements ToolEngine {
  private readonly child: ChildProcess;
  private buffer = "";
  private stderr = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  closed = false;

  constructor(cdpUrl: string) {
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
      await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "backroom", version: "1" } }, 30_000);
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

  /** One tool call, after the calls before it (one at a time per engine). */
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

/** The page lines of an engine's answer: those under its "## Pages" heading, with the engine's page ids. */
function pageLines(text: string): Array<{ page: number; label: string }> {
  const pages: Array<{ page: number; label: string }> = [];
  let inPages = false;
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (line.startsWith("## ")) inPages = line === "## Pages";
    const match = inPages ? PAGE_LINE.exec(line) : null;
    if (match) pages.push({ page: Number(match[1]), label: match[2] ?? "" });
  }
  return pages;
}

export interface ToolCaller {
  /** The agent's key from its briefing ("sol1.2fa05e45", "thread.1a2b3c4d"); null when none was given. */
  as: string | null;
  force: boolean;
}

export interface BrowserToolsDeps {
  browsers: RoomBrowsers;
  /** Resolve a browser by name (or id); null when there is none. */
  findBrowser: (nameOrId: string) => Browser | null;
  /**
   * The rules for an agent key: its room's ("sol1.2fa05e45" → the room whose id starts with 2fa05e45) or its thread's
   * ("thread.1a2b3c4d"); null for a key that names neither.
   */
  accessFor: (key: string) => BrowserAccess | null;
  log?: (message: string, detail?: unknown) => void;
  /** An engine on a browser's DevTools address (tests give a fake); default chrome-devtools-mcp. */
  engine?: (cdpUrl: string) => ToolEngine;
  /** One DevTools call on the browser itself (tests give a fake); default cdpCall. */
  cdp?: (cdpUrl: string, method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** How long an agent's engine may sit unused before it closes; default ENGINE_IDLE_MS. */
  engineIdleMs?: number;
}

/** An agent's engine on one browser, and what it calls each tab (an engine numbers pages in the order it meets them). */
interface AgentEngine {
  engine: ToolEngine;
  /** Chrome's tab id → this engine's page id, and back. */
  pages: Map<string, number>;
  tabs: Map<number, string>;
  /** Calls running or waiting; the idle timer runs only at none. */
  calls: number;
  idle: NodeJS.Timeout | null;
}

/** A running browser as the agents share it: one number per tab for everyone, who opened which, an engine per agent. */
class SharedBrowser {
  readonly startedAt: string | null;
  readonly cdpUrl: string;
  /** Chrome's tab id → the tab's number in rooms-browser, and back. Numbers are never reused while the browser runs. */
  private readonly numbers = new Map<string, number>();
  private readonly tabIds = new Map<number, string>();
  private next = 1;
  /** Tab number → the key of the agent that opened it. */
  readonly owners = new Map<number, string>();
  /** Agent key → its engine. */
  readonly engines = new Map<string, AgentEngine>();

  constructor(cdpUrl: string, startedAt: string | null) {
    this.cdpUrl = cdpUrl;
    this.startedAt = startedAt;
  }

  number(tabId: string): number {
    let number = this.numbers.get(tabId);
    if (number === undefined) {
      number = this.next++;
      this.numbers.set(tabId, number);
      this.tabIds.set(number, tabId);
    }
    return number;
  }

  tabId(number: number): string | undefined {
    return this.tabIds.get(number);
  }

  /** A closed tab: its number, owner and every engine's page id for it go. */
  forget(number: number): void {
    const tabId = this.tabIds.get(number);
    if (tabId === undefined) return;
    this.tabIds.delete(number);
    this.numbers.delete(tabId);
    this.owners.delete(number);
    for (const agent of this.engines.values()) {
      const page = agent.pages.get(tabId);
      agent.pages.delete(tabId);
      if (page !== undefined) agent.tabs.delete(page);
    }
  }

  close(): void {
    for (const agent of this.engines.values()) {
      if (agent.idle) clearTimeout(agent.idle);
      agent.engine.close();
    }
    this.engines.clear();
  }
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class BrowserTools {
  /** Browser id → the running browser's shared state. */
  private readonly shared = new Map<string, SharedBrowser>();
  private readonly deps: BrowserToolsDeps;

  constructor(deps: BrowserToolsDeps) {
    this.deps = deps;
  }

  /** Close the engines of a browser that stopped or restarted (its tab numbers and owners go with them). */
  browserChanged(browserId: string): void {
    const shared = this.shared.get(browserId);
    if (!shared) return;
    const status = this.deps.browsers.status(browserId);
    if (status.state !== "running" || status.startedAt !== shared.startedAt) {
      shared.close();
      this.shared.delete(browserId);
    }
  }

  closeAll(): void {
    for (const shared of this.shared.values()) shared.close();
    this.shared.clear();
  }

  /** Run one rooms-browser command line (argv without the program name). Returns the text to print. */
  async run(argv: string[], caller: ToolCaller): Promise<string> {
    const [first, second, third, ...rest] = argv;
    if (!first || first === "help" || first === "--help" || first === "-h") return HELP;
    const access = this.access(caller);
    if (first === "list") return this.list(access);
    const browser = this.deps.findBrowser(first);
    if (!browser) throw new BrowserToolError(`No browser named "${first}". ${this.list(access)}`, 404);
    if (!access.allowed.some((b) => b.id === browser.id)) {
      throw new BrowserToolError(`${capitalize(access.subject)} can't use "${browser.name}". Its browsers: ${access.allowed.map((b) => b.name).join(", ") || "none"}.`, 403);
    }
    if (second === undefined) throw new BrowserToolError(`Say what to do with "${browser.name}": tabs, open <url>, or <tab> <command>. Run "help" for all commands.`);
    if (second === "tabs") return this.tabs(browser, caller);
    if (second === "open") return this.open(browser, [third, ...rest].filter((x): x is string => x !== undefined), caller);
    if (!/^\d+$/.test(second)) throw new BrowserToolError(`"${second}" is not a tab id. Use "${browser.name} tabs" to list tabs, or "${browser.name} open <url>" to open yours.`);
    if (third === undefined) throw new BrowserToolError(`Say what to do on tab ${second}. Run "help" for the commands.`);
    return this.onTab(browser, Number(second), third, rest, caller);
  }

  private list(access: BrowserAccess): string {
    const lines = access.allowed.map((b) => {
      const state = this.deps.browsers.status(b.id).state;
      return `- ${b.name} (${state === "running" ? "running" : state === "error" ? "failed" : "stopped; starts on first use"})${b.description ? `: ${b.description}` : ""}`;
    });
    return lines.length > 0 ? `Browsers:\n${lines.join("\n")}` : "No browsers are available.";
  }

  /**
   * Whose rules the caller works under: every command but help names the agent, and its room or thread must have
   * browsers on. A room and a thread outside rooms are held to the same rules.
   */
  private access(caller: ToolCaller): BrowserAccess {
    if (!caller.as) throw new BrowserToolError("Pass --as <your key> (it is in your briefing): which browsers you may use depends on your room or thread.");
    const access = this.deps.accessFor(caller.as);
    if (!access) throw new BrowserToolError(`"${caller.as}" is not a key Backroom gave out. Use the one in your briefing.`, 403);
    if (!access.enabled) {
      throw new BrowserToolError(
        access.kind === "thread" ? "Browsers are turned off for this thread. The user turns them on with the globe in the thread's header." : `Browsers are turned off for ${access.subject}.`,
        403,
      );
    }
    return access;
  }

  /**
   * The running browser and the caller's own engine on it, starting the browser (and fresh state after a browser
   * restart) and the engine as needed.
   */
  private async use(browser: Browser, as: string): Promise<{ shared: SharedBrowser; agent: AgentEngine }> {
    let status = this.deps.browsers.status(browser.id);
    if (status.state !== "running") {
      try {
        status = await this.deps.browsers.ensure(browser.id);
      } catch (error) {
        throw new BrowserToolError(`"${browser.name}" could not start: ${(error as Error).message}`, 503);
      }
    }
    this.deps.browsers.touch(browser.id);
    if (!status.cdpUrl) throw new BrowserToolError(`"${browser.name}" has no DevTools address`, 503);
    let shared = this.shared.get(browser.id);
    if (!shared || shared.startedAt !== status.startedAt) {
      shared?.close();
      shared = new SharedBrowser(status.cdpUrl, status.startedAt);
      this.shared.set(browser.id, shared);
    }
    let agent = shared.engines.get(as);
    if (!agent || agent.engine.closed) {
      if (agent?.idle) clearTimeout(agent.idle);
      agent = { engine: this.deps.engine?.(status.cdpUrl) ?? new Engine(status.cdpUrl), pages: new Map(), tabs: new Map(), calls: 0, idle: null };
      shared.engines.set(as, agent);
      this.deps.log?.("browser engine started", { browser: browser.name, as });
    }
    return { shared, agent };
  }

  /**
   * One call on an agent's engine. An engine with no call for engineIdleMs closes, and so does one whose call timed
   * out (the engine is still stuck on it, and would hold every later call of the agent); the agent's next call starts
   * another.
   */
  private async call(shared: SharedBrowser, as: string, agent: AgentEngine, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    agent.calls += 1;
    if (agent.idle) clearTimeout(agent.idle);
    agent.idle = null;
    try {
      return await agent.engine.callTool(tool, args);
    } catch (error) {
      if (error instanceof BrowserToolError && error.status === 504 && shared.engines.get(as) === agent) {
        shared.engines.delete(as);
        agent.engine.close();
        this.deps.log?.("browser engine closed after a call timed out", { as, tool });
      }
      throw error;
    } finally {
      agent.calls -= 1;
      if (agent.calls === 0) {
        agent.idle = setTimeout(() => {
          if (agent.calls > 0 || shared.engines.get(as) !== agent) return;
          shared.engines.delete(as);
          agent.engine.close();
          this.deps.log?.("browser engine closed after no use", { as });
        }, this.deps.engineIdleMs ?? ENGINE_IDLE_MS);
        agent.idle.unref?.();
      }
    }
  }

  private cdp(cdpUrl: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return (this.deps.cdp ?? cdpCall)(cdpUrl, method, params);
  }

  /** Chrome's id of one of the engine's pages, asked once (get_tab_id); null when the page is gone. */
  private async tabOf(shared: SharedBrowser, as: string, agent: AgentEngine, page: number): Promise<string | null> {
    const known = agent.tabs.get(page);
    if (known !== undefined) return known;
    const { text, isError } = await this.call(shared, as, agent, "get_tab_id", { pageId: page });
    const tabId = isError ? null : (/Tab ID: (\S+)/.exec(text)?.[1] ?? null);
    if (tabId !== null) {
      agent.tabs.set(page, tabId);
      agent.pages.set(tabId, page);
    }
    return tabId;
  }

  /**
   * An engine's answer with its "## Pages" listing in tab numbers, each tab marked with whose it is, so an agent sees
   * which tabs are its own. The engine's notes on its selected page go: commands name their tab, the selection is
   * the engine's own.
   */
  private async renumber(text: string, shared: SharedBrowser, as: string, agent: AgentEngine): Promise<string> {
    const out: string[] = [];
    let inPages = false;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("## ")) inPages = trimmed === "## Pages";
      if (/^Note: the previously selected page/.test(trimmed)) continue;
      const match = inPages ? PAGE_LINE.exec(trimmed) : null;
      if (!match) {
        out.push(line);
        continue;
      }
      const tabId = await this.tabOf(shared, as, agent, Number(match[1]));
      if (tabId === null) continue;
      const number = shared.number(tabId);
      const owner = shared.owners.get(number);
      const mark = owner === undefined ? "not opened by an agent" : owner === as ? "yours" : `${owner}'s`;
      out.push(`${number}: ${match[2]} [${mark}]`);
    }
    return out.join("\n");
  }

  /** Every tab of the browser, from the agent's own engine: numbered, marked, and learnt by the engine. */
  private async listing(shared: SharedBrowser, as: string, agent: AgentEngine): Promise<string> {
    const { text, isError } = await this.call(shared, as, agent, "list_pages", {});
    if (isError) throw new BrowserToolError(text || "the tabs could not be listed", 422);
    return this.renumber(text, shared, as, agent);
  }

  private async tabs(browser: Browser, caller: ToolCaller): Promise<string> {
    const as = caller.as as string;
    const { shared, agent } = await this.use(browser, as);
    return this.listing(shared, as, agent);
  }

  /**
   * Open the agent's tab, in a window of its own. Backroom opens it over DevTools at an address no other tab has, finds
   * it among the agent's engine's pages, and has the engine load the URL there (waiting for the page as for any
   * navigation).
   */
  private async open(browser: Browser, args: string[], caller: ToolCaller): Promise<string> {
    if (!caller.as) throw new BrowserToolError('Pass --as <your key> (it is in your briefing) so the tab is yours.');
    const as = caller.as;
    const url = args.find((a) => !a.startsWith("--"));
    if (!url) throw new BrowserToolError(`Give a URL: ${browser.name} open <url>`);
    const { shared, agent } = await this.use(browser, as);
    const address = `${NEW_TAB}${randomBytes(6).toString("hex")}`;
    const created = (await this.cdp(shared.cdpUrl, "Target.createTarget", { url: address, newWindow: true, ...(args.includes("--background") ? { background: true } : {}) })) as {
      targetId?: string;
    };
    const discard = () => (created.targetId ? this.cdp(shared.cdpUrl, "Target.closeTarget", { targetId: created.targetId }).catch(() => undefined) : undefined);
    let page: number | undefined;
    for (const end = Date.now() + 10_000; page === undefined && Date.now() < end; ) {
      const { text } = await this.call(shared, as, agent, "list_pages", {});
      page = pageLines(text).find((p) => p.label === address)?.page;
      if (page === undefined) await sleep(200);
    }
    const tabId = page === undefined ? null : await this.tabOf(shared, as, agent, page);
    if (page === undefined || tabId === null) {
      await discard();
      throw new BrowserToolError("the new tab did not show up in the browser engine; try again", 502);
    }
    const number = shared.number(tabId);
    shared.owners.set(number, as);
    const loaded = await this.call(shared, as, agent, "navigate_page", { pageId: page, type: "url", url });
    if (loaded.isError || /^Unable to navigate/m.test(loaded.text)) {
      await discard();
      shared.forget(number);
      throw new BrowserToolError(loaded.text || "the tab did not open", 422);
    }
    this.deps.log?.("browser tab opened", { browser: browser.name, tab: number, as });
    return `Opened tab ${number} in "${browser.name}" (yours, in a window of its own). Next: ${browser.name} ${number} snapshot\n\n${await this.listing(shared, as, agent)}`;
  }

  /** The agent's engine's page id for a tab number; it lists the tabs first when it has not met the tab yet. */
  private async pageFor(browser: Browser, shared: SharedBrowser, as: string, agent: AgentEngine, number: number): Promise<number> {
    const page = () => {
      const tabId = shared.tabId(number);
      return tabId === undefined ? undefined : agent.pages.get(tabId);
    };
    if (page() === undefined) await this.listing(shared, as, agent);
    const found = page();
    if (found === undefined) throw new BrowserToolError(`There is no tab ${number} in "${browser.name}". Run "${browser.name} tabs" to list them.`, 404);
    return found;
  }

  /**
   * Whether Chrome draws the tab: only the tab in front of its window is drawn, and a screenshot of any other can hang
   * (B2's probes: 90 s, until the call timed out). Unknown (no answer, an older Chrome) counts as drawn.
   */
  private async drawn(shared: SharedBrowser, tabId: string): Promise<boolean> {
    try {
      const { targetInfos } = (await this.cdp(shared.cdpUrl, "Target.getTargets", { filter: [{ type: "tab" }] })) as {
        targetInfos?: Array<{ targetId: string; embedderData?: { tabActive?: boolean } }>;
      };
      return targetInfos?.find((t) => t.targetId === tabId)?.embedderData?.tabActive !== false;
    } catch {
      return true;
    }
  }

  private async onTab(browser: Browser, tab: number, command: string, args: string[], caller: ToolCaller): Promise<string> {
    const spec = TAB_COMMANDS[command];
    if (!spec) throw new BrowserToolError(`Unknown command "${command}". Run "help" for the commands.`);
    const as = caller.as as string;
    const { shared, agent } = await this.use(browser, as);
    const page = await this.pageFor(browser, shared, as, agent, tab);
    const owner = shared.owners.get(tab);
    if (!caller.force && (owner === undefined || owner !== as)) {
      const whose = owner === undefined ? "was not opened by an agent (it may be the user's)" : `belongs to ${owner}`;
      throw new BrowserToolError(`Tab ${tab} ${whose}. Open your own with "${browser.name} open <url>", or add --force if you really must use it.`, 403);
    }
    if (caller.force && owner !== as) this.deps.log?.("browser tab forced", { browser: browser.name, tab, as, owner: owner ?? null });
    const { tool, args: toolArgs } = spec.build(args, { tab, browser });
    if (tool === "take_screenshot" && !(await this.drawn(shared, shared.tabId(tab) as string))) {
      throw new BrowserToolError(
        `Tab ${tab} is behind another tab of its window, and Chrome draws only the tab in front: a screenshot of it can hang. Close the tab in front of it, or bring yours to the front with "${browser.name} ${tab} front".`,
        409,
      );
    }
    const { text, isError } = await this.call(shared, as, agent, tool, { pageId: page, ...toolArgs });
    if (isError) {
      if (/^No page found/.test(text)) {
        shared.forget(tab);
        throw new BrowserToolError(`Tab ${tab} is closed. Run "${browser.name} tabs" to list the tabs.`, 404);
      }
      throw new BrowserToolError(text || `${command} failed`, 422);
    }
    if (command === "close") shared.forget(tab);
    // Page lists in the answer (after close or navigation) get the same numbers and marks as "tabs".
    return text.includes("## Pages") ? this.renumber(text, shared, as, agent) : text || "Done.";
  }
}

/** One DevTools call on the browser itself, over a connection opened and closed around it. */
export async function cdpCall(cdpUrl: string, method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
  const version = (await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    .then((response) => response.json())
    .catch(() => null)) as { webSocketDebuggerUrl?: string } | null;
  const SocketCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!version?.webSocketDebuggerUrl || !SocketCtor) throw new BrowserToolError(`the browser did not answer on ${cdpUrl}`, 502);
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new SocketCtor(version.webSocketDebuggerUrl as string);
    const done = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // closing anyway
      }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new BrowserToolError(`the browser did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`, 504)), timeoutMs);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (message.id !== 1) return;
      if (message.error) done(new BrowserToolError(`${method}: ${message.error.message ?? "refused"}`, 502));
      else done(null, message.result);
    });
    socket.addEventListener("error", () => done(new BrowserToolError(`the browser's DevTools connection failed during ${method}`, 502)));
    socket.addEventListener("close", () => done(new BrowserToolError(`the browser closed its DevTools connection during ${method}`, 502)));
  });
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

  rooms-browser list --as <key>                    browsers you can use, what each is for, running or not
  rooms-browser <browser> tabs --as <key>          tabs, marked yours / another agent's / not opened by an agent
  rooms-browser <browser> open <url> --as <key>    open your own tab, in a window of its own; prints its id
  rooms-browser <browser> <tab> <command> --as <key>

Your key is in your briefing. It names your room or thread, and that decides which browsers you may use: the ones it
was given, and none while its browsers are off.

Commands on your tab:
${Object.values(TAB_COMMANDS)
  .map((c) => `  ${c.usage}`)
  .join("\n")}

snapshot prints the page as text with element uids (1_4); click, fill, hover and upload take those uids, from the
latest snapshot. screenshot saves a PNG and prints its path. A stopped browser starts on first use; its logins persist.
Work only in tabs you opened: other tabs belong to other agents or to the user, and are refused without --force.
Other agents work in the same browser at the same time, each in its own windows; neither waits for the other, and a
tab id names the same tab for everyone. Close your tabs when you are done.`;
