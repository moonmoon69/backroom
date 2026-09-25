/**
 * Serving images that agents write to disk and reference from replies, e.g. `![shot](/tmp/shot.png)`.
 * T3 Code renders those inline; here the room UI asks GET /api/local-image?path=... and this module decides
 * whether the path may be served. Only image files are served, and only from inside the allowed roots,
 * so the endpoint cannot be used to read arbitrary files.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, resolve, sep } from "node:path";

export const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

export const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;

export type LocalImageResolution = { ok: true; path: string; mimeType: string; size: number } | { ok: false; status: 400 | 403 | 404 | 413; reason: string };

/** Roots a reply may reference images from: the user's home (projects, worktrees, attachments) and the temp dir. */
export function defaultImageRoots(): string[] {
  return [homedir(), tmpdir(), "/tmp"].map((root) => safeRealpath(root)).filter((root, index, all) => root !== null && all.indexOf(root) === index) as string[];
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

const isInside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export function resolveLocalImage(requested: string, roots: string[] = defaultImageRoots()): LocalImageResolution {
  const raw = requested.startsWith("file://") ? decodeURIComponent(requested.slice("file://".length)) : requested;
  if (!raw || !isAbsolute(raw)) return { ok: false, status: 400, reason: "path must be absolute" };
  const mimeType = IMAGE_MIME_TYPES[extname(raw).toLowerCase()];
  if (!mimeType) return { ok: false, status: 403, reason: "not an image" };
  const real = safeRealpath(resolve(raw));
  if (!real) return { ok: false, status: 404, reason: "no such file" };
  // Symlinks are resolved before the root check so a link inside /tmp cannot point outside.
  if (!roots.some((root) => isInside(real, root))) return { ok: false, status: 403, reason: "outside allowed roots" };
  const stat = statSync(real);
  if (!stat.isFile()) return { ok: false, status: 404, reason: "not a file" };
  if (stat.size > MAX_LOCAL_IMAGE_BYTES) return { ok: false, status: 413, reason: "image too large" };
  return { ok: true, path: real, mimeType, size: stat.size };
}
