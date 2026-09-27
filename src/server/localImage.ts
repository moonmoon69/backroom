/**
 * Serving media that agents write to disk and reference from replies, e.g. `![shot](/tmp/shot.png)` or a recording
 * `![demo](/home/me/demo.mp4)`. T3 Code renders those inline; here the UI asks GET /api/local-file?path=... and this
 * module decides whether the path may be served. Only image, video and audio files are served, and only from inside
 * the allowed roots, so the endpoint cannot be used to read arbitrary files.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, resolve, sep } from "node:path";

export type LocalFileKind = "image" | "video" | "audio";

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

export const VIDEO_MIME_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
};

export const AUDIO_MIME_TYPES: Readonly<Record<string, string>> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
};

export const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;
/** Video and audio are streamed in ranges, so only an absurd size is refused. */
export const MAX_LOCAL_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;

export type LocalImageResolution = { ok: true; path: string; mimeType: string; size: number; kind: LocalFileKind } | { ok: false; status: 400 | 403 | 404 | 413; reason: string };

/** The kind and MIME type a file name is served as, or null when it is not served. */
export function localFileType(name: string): { kind: LocalFileKind; mimeType: string } | null {
  const extension = extname(name).toLowerCase();
  if (IMAGE_MIME_TYPES[extension]) return { kind: "image", mimeType: IMAGE_MIME_TYPES[extension]! };
  if (VIDEO_MIME_TYPES[extension]) return { kind: "video", mimeType: VIDEO_MIME_TYPES[extension]! };
  if (AUDIO_MIME_TYPES[extension]) return { kind: "audio", mimeType: AUDIO_MIME_TYPES[extension]! };
  return null;
}

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
  const type = localFileType(raw);
  if (!type) return { ok: false, status: 403, reason: "not an image, video or audio file" };
  const { kind, mimeType } = type;
  const real = safeRealpath(resolve(raw));
  if (!real) return { ok: false, status: 404, reason: "no such file" };
  // Symlinks are resolved before the root check so a link inside /tmp cannot point outside.
  if (!roots.some((root) => isInside(real, root))) return { ok: false, status: 403, reason: "outside allowed roots" };
  const stat = statSync(real);
  if (!stat.isFile()) return { ok: false, status: 404, reason: "not a file" };
  if (stat.size > (kind === "image" ? MAX_LOCAL_IMAGE_BYTES : MAX_LOCAL_MEDIA_BYTES)) return { ok: false, status: 413, reason: `${kind} too large` };
  return { ok: true, path: real, mimeType, size: stat.size, kind };
}
