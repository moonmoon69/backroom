/** Runtime configuration from environment variables and the local T3 runtime file. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  adapter: "fake" | "http";
  t3BaseUrl: string | null;
  t3AccessToken: string | null;
  t3UserDataDir: string;
  /** Scheduler tick interval in milliseconds. */
  tickMs: number;
  /** Delivery budget for a single briefing, in characters. */
  briefingBudgetChars: number;
  /** Room browsers (see src/browser/roomBrowsers.ts). */
  browser: {
    mode: "vnc" | "window" | "headless" | "off" | null;
    chromePath: string | null;
    bindHost: string;
    watchHost: string | null;
    noVncDir: string;
    idleMinutes: number;
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

function parseBrowserMode(value: string | undefined): Config["browser"]["mode"] {
  if (value === undefined || value === "" || value === "auto") return null;
  if (value === "vnc" || value === "window" || value === "headless" || value === "off") return value;
  throw new Error(`ROOMS_BROWSER_MODE must be auto, vnc, window, headless or off (got "${value}")`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.ROOMS_DATA_DIR ?? "data");
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
    tickMs: Number(env.ROOMS_TICK_MS ?? 1500),
    briefingBudgetChars: Number(env.ROOMS_BRIEFING_BUDGET ?? 60000),
    browser: {
      mode: parseBrowserMode(env.ROOMS_BROWSER_MODE),
      chromePath: env.ROOMS_BROWSER_CHROME ?? null,
      bindHost: env.ROOMS_BROWSER_BIND ?? "127.0.0.1",
      watchHost: env.ROOMS_BROWSER_HOST ?? null,
      noVncDir: env.ROOMS_BROWSER_NOVNC_DIR ?? "/usr/share/novnc",
      idleMinutes: Number(env.ROOMS_BROWSER_IDLE_MINUTES ?? 30),
    },
  };
}
