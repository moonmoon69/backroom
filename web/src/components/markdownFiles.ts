/**
 * File references inside markdown, mirroring T3 Code's chat rendering: inline code that names a file
 * (`web/src/App.tsx`, `/tmp/shot.png`, `src/parser.ts:42`) becomes a chip showing the basename with a
 * file-type badge, and local image paths are served through the room server.
 */

export interface FileReference {
  /** Full text as written, including any :line[:col] or :line-line suffix. */
  raw: string;
  /** Path without the suffix. */
  path: string;
  basename: string;
  extension: string;
  line?: number;
  /** Last line of a range (`http.ts:869-891`). */
  endLine?: number;
  column?: number;
}

/** Extensions we recognise as source or asset files when the reference has no directory part. */
const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "jsonc", "css", "scss", "sass", "less", "html", "htm", "vue", "svelte", "astro",
  "md", "mdx", "txt", "yml", "yaml", "toml", "ini", "env", "xml", "svg", "png", "jpg", "jpeg", "gif", "webp",
  "py", "rb", "rs", "go", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "ps1", "sql", "graphql", "proto", "lua", "ex", "exs", "erl", "hs", "ml", "scala", "dart", "zig", "nim", "r", "jl", "tf", "hcl", "dockerfile", "lock", "wasm",
]);

const BASENAME_ONLY = new Set(["dockerfile", "makefile", "package.json", "tsconfig.json", "readme.md", "license", ".gitignore", ".env", ".npmrc", ".editorconfig"]);

/** Does this inline code span name a file? Requires path-looking text with no spaces and a recognisable ending. */
export function parseFileReference(text: string): FileReference | null {
  const raw = text.trim();
  if (!raw || raw.length > 260 || /\s/.test(raw)) return null;
  // Not URLs, not shell, not expressions.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /[(){}<>|;&$*'"`=,]/.test(raw)) return null;
  const match = /^(.+?)(?::(\d+)(?:-(\d+)|:(\d+))?)?$/.exec(raw);
  if (!match) return null;
  const path = match[1] as string;
  if (path.endsWith("/") || path === "." || path === "..") return null;
  const basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  if (!basename) return null;
  const dot = basename.lastIndexOf(".");
  const extension = dot > 0 ? basename.slice(dot + 1).toLowerCase() : "";
  const hasDirectory = /[\\/]/.test(path);
  const isKnown = KNOWN_EXTENSIONS.has(extension) || BASENAME_ONLY.has(basename.toLowerCase());
  // A bare word with an odd extension (`example.com`, `document.title`) is not a file; a path with a slash is.
  if (!hasDirectory && !isKnown) return null;
  if (hasDirectory && !extension && !BASENAME_ONLY.has(basename.toLowerCase())) return null;
  // Rooted paths and dotted relatives are files; something like `a/b` needs an extension to count (handled above).
  if (hasDirectory && !/^(?:[~.]{0,2}\/|[A-Za-z]:\\|[\w.@-]+[\\/])/.test(path)) return null;
  const reference: FileReference = { raw, path, basename, extension };
  if (match[2]) reference.line = Number(match[2]);
  if (match[3]) reference.endLine = Number(match[3]);
  if (match[4]) reference.column = Number(match[4]);
  return reference;
}

/** Short badge text and hue per extension family, standing in for T3 Code's icon set. */
export function fileBadge(reference: FileReference): { label: string; tone: string } {
  const ext = reference.extension;
  const name = reference.basename.toLowerCase();
  if (ext === "tsx" || ext === "jsx") return { label: ext === "tsx" ? "TSX" : "JSX", tone: "react" };
  if (ext === "ts" || ext === "mts" || ext === "cts") return { label: "TS", tone: "ts" };
  if (ext === "js" || ext === "mjs" || ext === "cjs") return { label: "JS", tone: "js" };
  if (ext === "css" || ext === "scss" || ext === "sass" || ext === "less") return { label: ext.toUpperCase().slice(0, 4), tone: "css" };
  if (ext === "html" || ext === "htm" || ext === "vue" || ext === "svelte" || ext === "astro") return { label: ext.toUpperCase().slice(0, 4), tone: "html" };
  if (ext === "json" || ext === "jsonc" || ext === "yml" || ext === "yaml" || ext === "toml" || ext === "ini" || ext === "xml") return { label: ext.toUpperCase().slice(0, 4), tone: "data" };
  if (ext === "md" || ext === "mdx" || ext === "txt") return { label: ext.toUpperCase(), tone: "doc" };
  if (ext === "py") return { label: "PY", tone: "py" };
  if (ext === "rs") return { label: "RS", tone: "rs" };
  if (ext === "go") return { label: "GO", tone: "go" };
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "fish" || ext === "ps1") return { label: "SH", tone: "sh" };
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return { label: "IMG", tone: "img" };
  if (name === "dockerfile" || ext === "dockerfile") return { label: "DKR", tone: "data" };
  if (ext === "lock") return { label: "LOCK", tone: "muted" };
  return { label: (ext || name.slice(0, 3)).toUpperCase().slice(0, 4), tone: "muted" };
}

/** The route the service serves a local picture, recording or sound from; the HTML preview's sandbox admits only it. */
export const LOCAL_FILE_ROUTE = "/api/local-file";
const LOCAL_FILE_ENDPOINT = `${LOCAL_FILE_ROUTE}?path=`;

/** True for an absolute path on the machine (or a file URL), as opposed to a web URL or one of the app's own routes. */
export const isLocalPath = (src: string): boolean => src.startsWith("file://") || (src.startsWith("/") && !src.startsWith("//") && !src.startsWith("/api/") && !src.startsWith("/assets/"));

/**
 * Sources agents write as absolute paths (`/tmp/shot.png`, `file:///home/me/demo.mp4`) become Backroom URLs, served
 * by the service from the machine it runs on. Web URLs, data URLs, and the app's own routes pass through untouched.
 */
export function imageSource(src: string, base: string | null = null): string {
  if (src.startsWith("/api/") || src.startsWith("/assets/")) return src;
  if (src.startsWith("file://")) return LOCAL_FILE_ENDPOINT + encodeURIComponent(safeDecode(src.slice("file://".length)));
  if (isLocalPath(src)) return LOCAL_FILE_ENDPOINT + encodeURIComponent(src);
  // Relative to the folder the text was written in (a previewed document's, a reply's): `assets/banner.jpg`.
  if (base && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return LOCAL_FILE_ENDPOINT + encodeURIComponent(`${base.replace(/\/+$/, "")}/${src.replace(/^\.\//, "")}`);
  return src;
}

/** Elements that embed a picture, a recording or a sound, and the attributes that name one. */
const MEDIA_ELEMENT = /<(img|source|video|audio)\b([^>]*)>/gi;
const MEDIA_ATTRIBUTE = /(\s(src|poster|srcset)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;

/**
 * A previewed HTML document's local media (`shots/desk.png` next to it, `/tmp/shot.png`, a file URL) on img, source,
 * video and audio (src, poster, srcset), as Backroom URLs: the rule of a Markdown document's pictures, since the
 * preview's sandbox gives the document no folder of its own. Web, data and app URLs stay as written, as does the rest
 * of the document.
 */
export function localizeHtmlMedia(html: string, base: string): string {
  return html.replace(MEDIA_ELEMENT, (element: string, name: string, attributes: string) => {
    const mapped = attributes.replace(MEDIA_ATTRIBUTE, (attribute: string, prefix: string, key: string, quoted?: string, single?: string, bare?: string) => {
      const value = quoted ?? single ?? bare ?? "";
      if (!value.trim()) return attribute;
      const resolved = key.toLowerCase() === "srcset" ? localizeSrcset(value, base) : imageSource(value, base);
      return resolved === value ? attribute : `${prefix}"${resolved}"`;
    });
    return mapped === attributes ? element : `<${name}${mapped}>`;
  });
}

/** Each candidate's URL (`a.png 1x, b.png 2x`); a data URL's comma has no space after it, so it is not a separator. */
const localizeSrcset = (srcset: string, base: string): string => srcset.split(/,\s+/).map((candidate) => candidate.replace(/^(\s*)(\S+)/, (_, space: string, url: string) => `${space}${imageSource(url, base)}`)).join(", ");

export type MediaKind = "image" | "video" | "audio";
const VIDEO = /\.(mp4|m4v|webm|mov|ogv)(\?|#|$)/i;
const AUDIO = /\.(wav|mp3|m4a|aac|ogg|oga|flac)(\?|#|$)/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)(\?|#|$)/i;

/** Local-file display URLs carry the real media name in their path query. */
const mediaPath = (src: string): string => {
  try {
    const url = new URL(src, "http://backroom.local");
    return url.pathname === "/api/local-file" ? url.searchParams.get("path") ?? src : src;
  } catch {
    return src;
  }
};

export const isDataImage = (src: string): boolean => /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|bmp|avif|x-icon)(?:;[^,]*)?,/i.test(src);

/** Picture links (including extensionless attachments) use the image surface, never filePreview. */
export function isImageLink(src: string): boolean {
  if (isDataImage(src) || IMAGE.test(mediaPath(src))) return true;
  try {
    return /^\/api\/attachments\/[^/]+$/.test(new URL(src, "http://backroom.local").pathname);
  } catch {
    return false;
  }
}

/** What a source plays as, by its extension: markdown writes every embedded file as an image. */
export const mediaKind = (src: string): MediaKind => (VIDEO.test(mediaPath(src)) ? "video" : AUDIO.test(mediaPath(src)) ? "audio" : "image");

/**
 * GitHub's anchor for a heading, so a document's own links work (`[How it works](#how-it-works)`): lower case,
 * punctuation dropped, each space a hyphen.
 */
export function headingAnchor(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

/** Where a link points: a heading of the same text, a file on the machine (with GitHub's #L10 or #L10-L20), or the web. */
export type LinkTarget = { kind: "anchor"; anchor: string } | { kind: "file"; path: string; line?: number; endLine?: number } | { kind: "web" };

export function linkTarget(href: string): LinkTarget {
  if (href.startsWith("#")) return { kind: "anchor", anchor: safeDecode(href.slice(1)) };
  if (href.startsWith("/api/") || href.startsWith("/assets/")) return { kind: "web" };
  // A scheme (https:, mailto:) or a protocol-relative URL is the web; file: URLs and paths are files.
  if (href.startsWith("//") || (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file:"))) return { kind: "web" };
  const [location = "", hash = ""] = href.replace(/^file:\/\//, "").split("#");
  const path = safeDecode(location.split("?")[0] ?? "");
  if (!path) return { kind: "web" };
  const lines = /^L(\d+)(?:-L?(\d+))?$/.exec(hash);
  return { kind: "file", path, ...(lines ? { line: Number(lines[1]), ...(lines[2] ? { endLine: Number(lines[2]) } : {}) } : {}) };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
