/**
 * File references inside markdown, mirroring T3 Code's chat rendering: inline code that names a file
 * (`web/src/App.tsx`, `/tmp/shot.png`, `src/parser.ts:42`) becomes a chip showing the basename with a
 * file-type badge, and local image paths are served through the room server.
 */

import { decodeNamedCharacterReference } from "decode-named-character-reference";

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
const MEDIA_ELEMENTS = new Set(["img", "source", "video", "audio"]);
const MEDIA_ATTRIBUTES = new Set(["src", "poster", "srcset"]);
/** Elements whose content is text up to their end tag, not markup (noscript among them: the preview runs scripts). */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "noscript", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
/** HTML's whitespace: not JavaScript's `\s`, which takes a no-break space for one. */
const SPACE = "[\\t\\n\\f\\r ]";
const TAG_NAME = /<([a-z][^\t\n\f\r />]*)/iy;
/** One attribute: its name, then an optional value in double quotes, single quotes or bare (quoted may hold `>`; bare runs to whitespace or `>`). */
const ATTRIBUTE = /([\t\n\f\r ]*[^\t\n\f\r "'<>/=]+)(?:([\t\n\f\r ]*=[\t\n\f\r ]*)(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r >]+)))?/y;
const trimSpace = (text: string): string => text.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
/** A character reference: numeric with or without its semicolon, named with it. */
const CHARACTER_REFERENCE = /&(?:#([0-9]+);?|#[xX]([0-9a-fA-F]+);?|([a-zA-Z][a-zA-Z0-9]*);)/g;
/** What the HTML tokenizer makes of a numeric reference in the C1 range: the Windows-1252 characters. */
const C1_REPLACEMENTS: Readonly<Record<number, number>> = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 };
const numericReference = (code: number): string => (C1_REPLACEMENTS[code] !== undefined ? String.fromCodePoint(C1_REPLACEMENTS[code]!) : code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code));
const decodeCharacterReferences = (text: string): string =>
  text.replace(CHARACTER_REFERENCE, (reference, decimal?: string, hex?: string, name?: string) => (decimal !== undefined ? numericReference(Number(decimal)) : hex !== undefined ? numericReference(parseInt(hex, 16)) : decodeNamedCharacterReference(name!) || reference));
const encodeAttribute = (text: string): string => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * A previewed HTML document's local media (`shots/desk.png` next to it, `/tmp/shot.png`, a file URL) on img, source,
 * video and audio (src, poster, srcset), as Backroom URLs: the rule of a Markdown document's pictures, since the
 * preview's sandbox gives the document no folder of its own. The document is read as the HTML tokenizer reads it:
 * comments, CDATA and raw-text elements are text, a tag's attributes are read one at a time (a quoted value may hold
 * anything but its quote), character references are decoded before a path is mapped. Only the mapped attributes
 * change; the rest of the document is kept byte for byte. Pictures named in CSS (`url()`) are not mapped.
 */
export function localizeHtmlMedia(html: string, base: string): string {
  let out = "";
  let copied = 0;
  let at = 0;
  for (;;) {
    const open = html.indexOf("<", at);
    if (open < 0) break;
    const text = html.startsWith("<!--", open) ? "-->" : html.startsWith("<![CDATA[", open) ? "]]>" : null;
    if (text) {
      const close = html.indexOf(text, open + (text === "-->" ? 4 : 9));
      at = close < 0 ? html.length : close + 3;
      continue;
    }
    TAG_NAME.lastIndex = open;
    const tag = TAG_NAME.exec(html);
    if (!tag) {
      at = open + 1;
      continue;
    }
    const name = tag[1]!.toLowerCase();
    let p = TAG_NAME.lastIndex;
    let rewritten = html.slice(open, p);
    let changed = false;
    for (;;) {
      ATTRIBUTE.lastIndex = p;
      const attribute = ATTRIBUTE.exec(html);
      if (!attribute) break;
      p = ATTRIBUTE.lastIndex;
      const [whole, lead, equals, double, single, bare] = attribute;
      const value = trimSpace(double ?? single ?? bare ?? "");
      const key = trimSpace(lead!).toLowerCase();
      if (!value || !MEDIA_ELEMENTS.has(name) || !MEDIA_ATTRIBUTES.has(key)) {
        rewritten += whole;
        continue;
      }
      const decoded = decodeCharacterReferences(value);
      const resolved = key === "srcset" ? localizeSrcset(decoded, base) : imageSource(decoded, base);
      if (resolved === decoded) rewritten += whole;
      else {
        rewritten += `${lead}${equals}"${encodeAttribute(resolved)}"`;
        changed = true;
      }
    }
    const close = html.indexOf(">", p);
    at = close < 0 ? html.length : close + 1;
    if (changed) {
      out += html.slice(copied, open) + rewritten + html.slice(p, at);
      copied = at;
    }
    // A raw-text element's content runs from the end of its start tag to its end tag, whatever its attributes held.
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const end = new RegExp(`</${name}(?=${SPACE}|/|>)`, "ig");
      end.lastIndex = at;
      const endTag = end.exec(html);
      at = endTag ? endTag.index : html.length;
    }
  }
  return out + html.slice(copied);
}

/**
 * The candidates of a srcset, as a browser reads them: a URL runs to the next whitespace, so a data URL's commas are
 * its own; a URL ending in a comma has no descriptors, else they run to the next comma. The srcset is returned as it
 * was when no candidate is local.
 */
function localizeSrcset(srcset: string, base: string): string {
  const candidates: string[] = [];
  let changed = false;
  let p = 0;
  while (p < srcset.length) {
    const start = /[^\t\n\f\r ,]/g;
    start.lastIndex = p;
    const first = start.exec(srcset);
    if (!first) break;
    const space = /[\t\n\f\r ]|$/g;
    space.lastIndex = first.index;
    const end = space.exec(srcset)!.index;
    let url = srcset.slice(first.index, end);
    let descriptors = "";
    p = end;
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      const comma = srcset.indexOf(",", p);
      descriptors = trimSpace(comma < 0 ? srcset.slice(p) : srcset.slice(p, comma));
      p = comma < 0 ? srcset.length : comma + 1;
    }
    const resolved = imageSource(url, base);
    if (resolved !== url) changed = true;
    candidates.push(descriptors ? `${resolved} ${descriptors}` : resolved);
  }
  return changed ? candidates.join(", ") : srcset;
}

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
