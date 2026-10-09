/**
 * A browser's ports and X display (data/browsers/<id>/ports.json). They are the machine's, not one Backroom's: the
 * user's Backroom and throwaway ones (tests and rehearsals, each with a data folder of its own) start browsers on the
 * same machine, and a stopped browser keeps its ports so the address agents were given stays valid.
 *
 * So every Backroom records the ports and displays its browsers saved in one folder they all share
 * (ROOMS_BROWSER_PORTS_DIR): a file per port or display, naming the Backroom's browsers folder. None gives a browser a
 * port or display that another Backroom's browsers folder still names, running or not (#598). A record whose folder no
 * longer names it is stale, and free to take. Browsers of one Backroom may share saved ports, as before: only one of
 * them runs on a port at a time.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

export interface Ports {
  cdp: number;
  vnc: number;
  web: number;
  display: number;
}

type Kind = "port" | "display";

/** Ports a ports.json names, and its display. */
function named(saved: Partial<Ports>, kind: Kind): number[] {
  return kind === "display" ? [saved.display ?? 0] : [saved.cdp ?? 0, saved.vnc ?? 0, saved.web ?? 0];
}

/** The machine's records of which Backroom's browsers keep which ports and displays. */
export class PortReservations {
  private readonly dir: string;
  /** A record this young is good even before its ports.json is written (a Backroom choosing ports right now). */
  private readonly graceMs: number;

  constructor(dir: string, graceMs = 60_000) {
    this.dir = dir;
    this.graceMs = graceMs;
  }

  private file(kind: Kind, value: number): string {
    return join(this.dir, `${kind}-${value}`);
  }

  /** Whether any ports.json under a browsers folder names the port or display. */
  private static names(owner: string, kind: Kind, value: number): boolean {
    if (!existsSync(owner)) return false;
    return readdirSync(owner).some((id) => {
      try {
        return named(JSON.parse(readFileSync(join(owner, id, "ports.json"), "utf8")) as Partial<Ports>, kind).includes(value);
      } catch {
        return false;
      }
    });
  }

  /** The other Backroom's browsers folder that keeps the port or display, or null (free, stale, or `owner`'s own). */
  heldByOther(kind: Kind, value: number, owner: string): string | null {
    const file = this.file(kind, value);
    let holder: string;
    try {
      holder = readFileSync(file, "utf8").trim();
    } catch {
      return null;
    }
    if (holder === owner) return null;
    const fresh = this.graceMs > 0 && Date.now() - statSync(file).mtimeMs < this.graceMs;
    return fresh || PortReservations.names(holder, kind, value) ? holder : null;
  }

  /** Record the port or display as `owner`'s; false when another Backroom keeps it. */
  reserve(kind: Kind, value: number, owner: string): boolean {
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(kind, value);
    try {
      writeFileSync(file, owner, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (this.heldByOther(kind, value, owner) !== null) return false;
    writeFileSync(file, owner);
    return true;
  }

  /**
   * Record what every ports.json under a browsers folder saved. Returns, for each port or display another Backroom
   * keeps, a line saying so (that browser gets another at its next start).
   */
  reserveSaved(owner: string): string[] {
    if (!existsSync(owner)) return [];
    const conflicts: string[] = [];
    for (const id of readdirSync(owner)) {
      let saved: Partial<Ports>;
      try {
        saved = JSON.parse(readFileSync(join(owner, id, "ports.json"), "utf8")) as Partial<Ports>;
      } catch {
        continue;
      }
      for (const kind of ["port", "display"] as const) {
        for (const value of named(saved, kind).filter((v) => v > 0)) {
          if (!this.reserve(kind, value, owner)) conflicts.push(`${id}: ${kind} ${value} is kept by ${this.heldByOther(kind, value, owner)}`);
        }
      }
    }
    return conflicts;
  }
}

export interface PortChoice {
  /** The browser's ports.json: what it saved is kept when it can be, and what is chosen is written there. */
  file: string;
  mode: "vnc" | "window" | "headless";
  /** Address noVNC listens on. */
  bindHost: string;
  /** Ports and displays of this Backroom's running browsers. */
  taken: Set<number>;
  takenDisplays: Set<number>;
  /** The machine's records; null keeps to this Backroom's own (tests). */
  reservations: PortReservations | null;
  /** This Backroom's browsers folder, the name its records carry. */
  owner: string;
}

/** Ports and display for a browser about to start: its saved ones while they are free and no other Backroom's, else new ones. */
export async function choosePorts(c: PortChoice): Promise<Ports> {
  let saved: Partial<Ports> = {};
  try {
    saved = JSON.parse(readFileSync(c.file, "utf8")) as Partial<Ports>;
  } catch {
    saved = {};
  }
  const ours = (kind: Kind, value: number) => c.reservations?.heldByOther(kind, value, c.owner) == null;
  const claim = (kind: Kind, value: number) => c.reservations?.reserve(kind, value, c.owner) ?? true;
  const pick = async (preferred: number | undefined, base: number, host: string): Promise<number> => {
    // The saved port keeps the address agents were given; a browser that was just stopped may still hold it briefly.
    if (preferred && !c.taken.has(preferred) && ours("port", preferred)) {
      const deadline = Date.now() + 5000;
      while (!(await portFree(preferred, host)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      if ((await portFree(preferred, host)) && claim("port", preferred)) {
        c.taken.add(preferred);
        return preferred;
      }
    }
    for (let port = base; port < base + 500; port += 1) {
      if (!c.taken.has(port) && ours("port", port) && (await portFree(port, host)) && claim("port", port)) {
        c.taken.add(port);
        return port;
      }
    }
    throw new Error(`no free port near ${base}`);
  };
  const cdp = await pick(saved.cdp, 9300, "127.0.0.1");
  const vnc = c.mode === "vnc" ? await pick(saved.vnc, 5950, "127.0.0.1") : (saved.vnc ?? 0);
  const web = c.mode === "vnc" ? await pick(saved.web, 6100, c.bindHost) : (saved.web ?? 0);
  let display = saved.display ?? 0;
  if (c.mode === "vnc") {
    const free = (n: number) => !c.takenDisplays.has(n) && !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`) && ours("display", n);
    if (!display || !free(display) || !claim("display", display)) {
      display = 0;
      for (let n = 100; n < 400; n += 1) {
        if (free(n) && claim("display", n)) {
          display = n;
          break;
        }
      }
      if (!display) throw new Error("no free X display");
    }
  }
  const ports: Ports = { cdp, vnc, web, display };
  writeFileSync(c.file, JSON.stringify(ports, null, 2));
  return ports;
}

export function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

/**
 * The data folder of the main checkout of the git repository `dir` is in: the user's Backroom's, when this one runs
 * from a worktree (a throwaway for tests and rehearsals). Null outside git.
 */
export function mainCheckoutData(dir: string): string | null {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return join(dirname(common), "data");
  } catch {
    return null;
  }
}
