/**
 * The parts of scripts/rehearse.ts that decide without a browser or a service (T2), here so the tests can reach them
 * (rehearse.ts runs as it is imported): the command line, read strictly; whether rooms-browser's answer says our tab is
 * gone; and whether a step the launcher started passed.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The flags that take a value (--only as often as wanted), and those that stand alone. */
const VALUES = new Set(["--step", "--as", "--browser", "--keys-browser", "--port", "--data", "--out", "--browser-cli", "--only", "--until"]);
const REPEATED = new Set(["--only"]);
const SWITCHES = new Set(["--keep", "--list", "--help"]);

export interface Args {
  /** Each flag's value (the last of a repeated one is its last value; --only keeps them all). */
  value(flag: string): string | undefined;
  all(flag: string): string[];
  has(flag: string): boolean;
}

/**
 * The command line, every flag known and every value there: a flag that takes a value and is last, or is followed by
 * another flag, is an error, not a flag taken for a value; an unknown flag or a word on its own is an error too.
 */
export function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (SWITCHES.has(arg)) {
      switches.add(arg);
      continue;
    }
    if (!VALUES.has(arg)) throw new Error(arg.startsWith("-") ? `unknown flag ${arg}` : `${JSON.stringify(arg)} is not a flag (a state is named with --only or --until)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    if (values.has(arg) && !REPEATED.has(arg)) throw new Error(`${arg} is given twice`);
    values.set(arg, [...(values.get(arg) ?? []), value]);
    i += 1;
  }
  return {
    value: (flag) => values.get(flag)?.at(-1),
    all: (flag) => values.get(flag) ?? [],
    has: (flag) => switches.has(flag),
  };
}

/**
 * What a rehearsal writes in its data folder while its service runs ("service.pid"): the service's pid, its own pid and
 * the port. The launcher stops a service left behind only if the record is its child's (so never another run's, whose
 * folder a refused child shares), and a run refuses a folder whose service still runs.
 */
export interface ServiceRecord {
  service: number;
  owner: number;
  port: number;
}
export function serviceRecord(text: string): ServiceRecord | null {
  const m = /^(\d+) (\d+) (\d+)\s*$/.exec(text);
  return m ? { service: Number(m[1]), owner: Number(m[2]), port: Number(m[3]) } : null;
}
export function recordText(record: ServiceRecord): string {
  return `${record.service} ${record.owner} ${record.port}\n`;
}
/** Whether a record found after a launcher's child ended is that child's, for its port. */
export function recordOf(record: ServiceRecord | null, child: number | undefined, port: number): record is ServiceRecord {
  return record !== null && record.owner === child && record.port === port;
}

/**
 * The tabs rooms-browser's `tabs` listing marks as ours on a service's address, in order: its URL followed by a slash,
 * so the service on :4521 is not taken for one on :45210.
 */
export function ourTabs(listing: string, url: string): string[] {
  return [...listing.matchAll(/^(\d+): .*\((https?:\/\/[^)]*)\) \[yours\]/gm)].filter((m) => m[2]!.startsWith(`${url}/`)).map((m) => m[1]!);
}

/**
 * The service's record taken out of its data folder once the service is gone (stopped, or killed to start again), if
 * it is this run's (`owner`) and its service no longer runs (`running`; a second stop while the first still waits for
 * the service to end leaves it for the launcher): a record left behind would name a dead service, or another run's.
 * Returns whether it did.
 */
export function clearRecord(data: string, owner: number, running: (pid: number) => boolean): boolean {
  const file = join(data, "service.pid");
  const record = existsSync(file) ? serviceRecord(readFileSync(file, "utf8")) : null;
  if (record?.owner !== owner || running(record.service)) return false;
  rmSync(file, { force: true });
  return true;
}

/** A port for a throwaway service: a whole number from 1024 to 65535. */
export function portOf(text: string | undefined, fallback: number): number {
  const port = text === undefined ? fallback : Number(text);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`--port ${text} is not a port from 1024 to 65535`);
  return port;
}

/**
 * Whether rooms-browser refused a command for the tab it names (gone, or not ours: the browser restarted, or our tab was
 * closed): then, and only then, the tab is looked up again. Any other failure (a timeout, the page's error) is the
 * command's own, and it is not sent again.
 */
export function tabGone(answer: string): boolean {
  return /There is no tab \d+|Tab \d+ is closed|Tab \d+ (belongs to|was not opened by an agent)/.test(answer);
}

/**
 * Whether a step the launcher started passed: only a child that started and exited by itself with 0. A child that could
 * not start, exited with any other code, or was ended by a signal (its code then null) failed.
 */
export function stepPassed(code: number | null, signal: string | null, startError: Error | null = null): boolean {
  return startError === null && signal === null && code === 0;
}
