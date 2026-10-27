/**
 * Previewing a file a reply names (`src/parser.ts:42`, `docs/plan.md`, `/tmp/check.log`): GET /api/file-preview.
 * Any file the service can read is previewed, wherever it is and through symlinks (a project's `docs` may be a link
 * to a folder elsewhere), never one that looks like a secret, and text only up to a size. Images, recordings and
 * sounds are handed to /api/local-file instead, which serves them from the home and temp folders.
 */
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { localFileType, type LocalFileKind } from "./localImage.ts";

/** Text beyond this is cut; the preview says so. */
export const MAX_PREVIEW_BYTES = 512 * 1024;

export type FilePreview =
  | { ok: true; path: string; size: number; kind: "text"; content: string; truncated: boolean }
  | { ok: true; path: string; size: number; kind: LocalFileKind; url: string }
  | { ok: true; path: string; size: number; kind: "binary" }
  | { ok: false; status: 400 | 403 | 404; reason: string };

/** Names that hold keys and tokens: never previewed, wherever they are. */
const SECRET_NAMES = [
  /^\.env(\.(?!example$|sample$|template$)[^/]*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?(netrc|npmrc|pypirc)$/i,
  /^(t3-auth|browser-api)\.json$/i,
];
/** Folders that hold them. */
const SECRET_FOLDERS = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker"]);

const isSecret = (path: string): boolean => SECRET_NAMES.some((pattern) => pattern.test(basename(path))) || path.split(sep).some((part) => SECRET_FOLDERS.has(part));

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Folders never searched for a file named without its folder: dependencies, history, build output. */
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "target", "vendor", "coverage", ".cache", ".venv", "__pycache__"]);
/** How many entries a search by name looks at in one folder tree before giving up. */
const SEARCH_LIMIT = 20_000;

/** A file called `name` under `root`, the shallowest first (`Crew.tsx` → web/src/components/Crew.tsx); null if none. */
function findByName(root: string, name: string): string | null {
  const queue = [root];
  let seen = 0;
  while (queue.length > 0 && seen < SEARCH_LIMIT) {
    const folder = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    seen += entries.length;
    const hit = entries.find((entry) => entry.isFile() && entry.name === name);
    if (hit) return join(folder, hit.name);
    for (const entry of entries) if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)) queue.push(join(folder, entry.name));
  }
  return null;
}

/**
 * The file `requested` names, and what to show for it. A relative path is looked for in `base` (the folder the reply
 * was written in) first, then in each of `folders` (the projects and their threads' worktrees). Symlinks are resolved
 * before the secret check, so a link to a key is refused as the key is.
 */
export function previewFile(requested: string, options: { base?: string | null; folders: string[] }): FilePreview {
  let raw = requested.trim();
  if (raw.startsWith("file://")) raw = decodeURIComponent(raw.slice("file://".length));
  if (!raw) return { ok: false, status: 400, reason: "no path" };
  if (raw === "~" || raw.startsWith("~/")) raw = join(homedir(), raw.slice(1));
  const folders = isAbsolute(raw) ? [] : [options.base ?? null, ...options.folders].filter((folder, index, all): folder is string => Boolean(folder && isAbsolute(folder)) && all.indexOf(folder) === index);
  let real: string | null = null;
  for (const path of isAbsolute(raw) ? [raw] : folders.map((folder) => resolve(folder, raw))) {
    real = safeRealpath(path);
    if (real) break;
  }
  // A file named without its folder (`Crew.tsx`): looked for by name, in the reply's folder first, then each project.
  if (!real && !isAbsolute(raw) && !/[\\/]/.test(raw)) {
    for (const folder of folders) {
      const found = findByName(folder, raw);
      real = found ? safeRealpath(found) : null;
      if (real) break;
    }
  }
  if (!real) return { ok: false, status: 404, reason: "no such file" };
  const stat = statSync(real);
  if (stat.isDirectory()) return { ok: false, status: 400, reason: "a folder, not a file" };
  if (!stat.isFile()) return { ok: false, status: 404, reason: "not a file" };
  if (isSecret(real)) return { ok: false, status: 403, reason: "it may hold keys or tokens, so it is not previewed" };
  const media = localFileType(real);
  if (media) return { ok: true, path: real, size: stat.size, kind: media.kind, url: `/api/local-file?path=${encodeURIComponent(real)}` };
  const length = Math.min(stat.size, MAX_PREVIEW_BYTES);
  const bytes = Buffer.alloc(length);
  const fd = openSync(real, "r");
  try {
    readSync(fd, bytes, 0, length, 0);
  } finally {
    closeSync(fd);
  }
  // A NUL early on: an executable, an archive, a database. Not text.
  if (bytes.subarray(0, 8192).includes(0)) return { ok: true, path: real, size: stat.size, kind: "binary" };
  return { ok: true, path: real, size: stat.size, kind: "text", content: new TextDecoder("utf-8").decode(bytes), truncated: stat.size > MAX_PREVIEW_BYTES };
}
