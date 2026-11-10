/** Runtime configuration from environment variables and the local T3 runtime file. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PSTACK_REPO } from "./domain/skills.ts";

/**
 * This copy of Backroom: the git checkout this file is in, whatever folder the service is started from. Its data is in
 * its ./data and its page in its web/dist unless ROOMS_DATA_DIR and ROOMS_WEB_DIST say otherwise; its version is its
 * package.json's, which a release tag v<version> names (install.sh).
 */
export const COPY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const COPY_VERSION = (JSON.parse(readFileSync(join(COPY_ROOT, "package.json"), "utf8")) as { version: string }).version;

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  adapter: "fake" | "http";
  t3BaseUrl: string | null;
  t3AccessToken: string | null;
  t3UserDataDir: string;
  /** T3's home on this machine (T3CODE_HOME, else the folder above its userdata), where its service keeps its versions. */
  t3Home: string;
  /** T3's CLI that keeps Backroom's credential (src/app/t3Credential.ts): T3_CLI, "off" for none, else the version T3's service runs. */
  t3Cli: string | null;
  /** The engine host's tick interval in milliseconds. */
  tickMs: number;
  /** The built UI the service serves. */
  webDistDir: string;
  /** Delivery budget for a single briefing, in characters. */
  briefingBudgetChars: number;
  /** Where the pstack pack is cloned from (ROOMS_PSTACK_REPO, a URL or a local path; src/app/packs.ts). */
  pstackRepo: string;
  /**
   * The home folder whose skill folders (~/.claude/skills and the others) Backroom links skills into (ROOMS_SKILLS_HOME):
   * the user's own, or for a service on the fake T3 a folder in its data folder, so a throwaway service never links into
   * the user's harnesses.
   */
  skillsHome: string;
  /** How long deleting a room waits for T3 to answer each thread action, in milliseconds. */
  threadActionTimeoutMs: number;
  /**
   * H6, the engine runtime: how long a seat with work in flight may go without a wake before it gets a keep-alive, in
   * milliseconds (ROOMS_KEEPALIVE_MS): 55 minutes by default, from a minute to under the prompt cache's hour; 0 turns
   * keep-alives off.
   * A room may set its own (`rooms-board keepalive every <minutes>`).
   */
  keepAliveMs: number;
  /** Room browsers (see src/browser/roomBrowsers.ts). */
  browser: {
    mode: "vnc" | "window" | "headless" | "off" | null;
    chromePath: string | null;
    bindHost: string;
    watchHost: string | null;
    noVncDir: string;
    idleMinutes: number;
    /** The folder this machine's Backrooms share to record which keeps which browser ports (src/browser/ports.ts); null: off. */
    portsDir: string | null;
  };
  /** Where the harnesses keep their transcripts, read for a thread's usage and cost (src/usage/threadCosts.ts). */
  usage: {
    claudeProjectsDir: string;
    codexSessionsDir: string;
  };
}

export function readT3RuntimeOrigin(userDataDir: string): string | null {
  const path = join(userDataDir, "server-runtime.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { origin?: string };
    return typeof parsed.origin === "string" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function parseKeepAliveMs(value: string | undefined): number {
  if (value === undefined || value === "") return 55 * 60_000;
  const ms = Number(value);
  // A minute at least, as the board's `keepalive every` takes: a unit slip (55 for 55 minutes) would wake seats back to back.
  if (!Number.isInteger(ms) || (ms !== 0 && (ms < 60_000 || ms >= 60 * 60_000))) {
    throw new Error(`ROOMS_KEEPALIVE_MS must be 0 (off) or a whole number of milliseconds from 60000 (a minute) to 3599999, under the prompt cache's hour (got "${value}")`);
  }
  return ms;
}

function parseBrowserMode(value: string | undefined): Config["browser"]["mode"] {
  if (value === undefined || value === "" || value === "auto") return null;
  if (value === "vnc" || value === "window" || value === "headless" || value === "off") return value;
  throw new Error(`ROOMS_BROWSER_MODE must be auto, vnc, window, headless or off (got "${value}")`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.ROOMS_DATA_DIR ? resolve(env.ROOMS_DATA_DIR) : join(COPY_ROOT, "data");
  const t3UserDataDir = env.T3_USERDATA_DIR ?? join(homedir(), ".t3", "userdata");
  const adapter = env.ROOMS_ADAPTER === "fake" ? "fake" : "http";
  return {
    port: Number(env.ROOMS_PORT ?? 4400),
    dataDir,
    dbPath: env.ROOMS_DB_PATH ?? join(dataDir, "rooms.sqlite"),
    adapter,
    t3BaseUrl: env.T3_BASE_URL ?? readT3RuntimeOrigin(t3UserDataDir),
    t3AccessToken: env.T3_ACCESS_TOKEN ?? null,
    t3UserDataDir,
    t3Home: env.T3CODE_HOME ?? dirname(t3UserDataDir),
    t3Cli: env.T3_CLI || null,
    tickMs: Number(env.ROOMS_TICK_MS ?? 1500),
    webDistDir: env.ROOMS_WEB_DIST ? resolve(env.ROOMS_WEB_DIST) : join(COPY_ROOT, "web", "dist"),
    briefingBudgetChars: Number(env.ROOMS_BRIEFING_BUDGET ?? 60000),
    // A local path is taken from the working directory, as the overrides above: git clones from another folder.
    pstackRepo: env.ROOMS_PSTACK_REPO ? (/^[a-z][a-z0-9+.-]*:\/\/|^[^/]+@[^/:]+:/i.test(env.ROOMS_PSTACK_REPO) ? env.ROOMS_PSTACK_REPO : resolve(env.ROOMS_PSTACK_REPO)) : PSTACK_REPO,
    skillsHome: env.ROOMS_SKILLS_HOME ? resolve(env.ROOMS_SKILLS_HOME) : adapter === "fake" ? join(dataDir, "home") : homedir(),
    threadActionTimeoutMs: Number(env.ROOMS_THREAD_ACTION_TIMEOUT_MS ?? 5000),
    keepAliveMs: parseKeepAliveMs(env.ROOMS_KEEPALIVE_MS),
    browser: {
      mode: parseBrowserMode(env.ROOMS_BROWSER_MODE),
      chromePath: env.ROOMS_BROWSER_CHROME ?? null,
      bindHost: env.ROOMS_BROWSER_BIND ?? "127.0.0.1",
      watchHost: env.ROOMS_BROWSER_HOST ?? null,
      noVncDir: env.ROOMS_BROWSER_NOVNC_DIR ?? "/usr/share/novnc",
      idleMinutes: Number(env.ROOMS_BROWSER_IDLE_MINUTES ?? 30),
      portsDir:
        env.ROOMS_BROWSER_PORTS_DIR === "off"
          ? null
          : (env.ROOMS_BROWSER_PORTS_DIR ?? join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "backroom", "browser-ports")),
    },
    // The harnesses' own variables for their home, as T3 starts them with the same environment.
    usage: {
      claudeProjectsDir: join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
      codexSessionsDir: join(env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
    },
  };
}
