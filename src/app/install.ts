/**
 * How this copy of Backroom was installed, which decides where its data lives, where its page is, and how it is updated.
 * - checkout: a git checkout, run with `npm start`; data in its ./data, never updated by Backroom (git does that).
 * - global: the package in npm's global folder, run with the `backroom` command; data in ~/.backroom, updated by Backroom.
 * - package: the package anywhere else (npx's cache, a local install); data in ~/.backroom, updated by the user.
 * ROOMS_DATA_DIR and ROOMS_WEB_DIST override the two folders (src/config.ts). The page is always the copy's own
 * web/dist, found from the copy's folder and never from the working directory.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type InstallKind = "checkout" | "global" | "package";

export interface Install {
  kind: InstallKind;
  /** The copy's own folder: the checkout, or the package's folder. */
  root: string;
  /** The package's name and version, from its package.json: the only place either is written. */
  name: string;
  version: string;
  /** Where its data lives unless ROOMS_DATA_DIR says otherwise. */
  dataDir: string;
  /** Its built page. */
  webDistDir: string;
  /** The npm that came with the node running this copy, as a script for that node; null when that node has none. */
  npmCli: string | null;
  /** For a global copy, the npm prefix whose global folder holds it, where its update is installed. */
  prefix: string | null;
}

/** This file is src/app/install.ts in a checkout and dist/app/install.js in a package: the copy's folder is two up. */
const OWN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** npm's own script beside a node binary, as Node's installers lay it out. */
export function npmBeside(execPath: string, platform: NodeJS.Platform = process.platform): string | null {
  const cli = platform === "win32" ? join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js") : join(dirname(dirname(execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(cli) ? cli : null;
}

/**
 * The npm prefix whose global folder holds this copy: the copy is that prefix's lib/node_modules/<name> (node_modules/<name>
 * on Windows) and the prefix's command links to it, as `npm install --global` leaves them. Read from the disk, not from
 * npm's answer, which masks parts of a path that look like a secret.
 */
function globalPrefix(root: string, name: string, command: string | null, platform: NodeJS.Platform): string | null {
  const folder = platform === "win32" ? join("node_modules", name) : join("lib", "node_modules", name);
  if (!command || !root.endsWith(sep + folder)) return null;
  const prefix = root.slice(0, -(folder.length + 1));
  if (platform === "win32") return existsSync(join(prefix, `${command}.cmd`)) ? prefix : null;
  try {
    return dirname(dirname(realpathSync(join(prefix, "bin", command)))) === realpathSync(root) ? prefix : null;
  } catch {
    return null;
  }
}

export function detectInstall(options: { root?: string; home?: string; execPath?: string; platform?: NodeJS.Platform } = {}): Install {
  const root = options.root ?? OWN_ROOT;
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown; bin?: unknown };
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") throw new Error(`${join(root, "package.json")} has no name or version`);
  const { name, version } = manifest as { name: string; version: string };
  const npmCli = npmBeside(execPath, platform);
  const command = manifest.bin && typeof manifest.bin === "object" ? (Object.keys(manifest.bin)[0] ?? null) : null;
  const webDistDir = join(root, "web", "dist");
  // A worktree's .git is a file, a checkout's a folder: either is a checkout. A packed copy has neither.
  if (existsSync(join(root, ".git"))) return { kind: "checkout", root, name, version, dataDir: join(root, "data"), webDistDir, npmCli, prefix: null };
  // Updating a copy needs the npm of its node; without it, a copy in a global folder is one the user updates.
  const prefix = npmCli ? globalPrefix(root, name, command, platform) : null;
  return { kind: prefix ? "global" : "package", root, name, version, dataDir: join(options.home ?? homedir(), ".backroom"), webDistDir, npmCli, prefix };
}
