/**
 * File references inside markdown, mirroring T3 Code's chat rendering: inline code that names a file
 * (`web/src/App.tsx`, `/tmp/shot.png`, `src/parser.ts:42`) becomes a chip showing the basename with a
 * file-type badge, and local image paths are served through the room server.
 */

export interface FileReference {
  /** Full text as written, including any :line[:col] suffix. */
  raw: string;
  /** Path without the :line[:col] suffix. */
  path: string;
  basename: string;
  extension: string;
  line?: number;
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
  const match = /^(.+?)(?::(\d+)(?::(\d+))?)?$/.exec(raw);
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
  if (match[3]) reference.column = Number(match[3]);
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

const LOCAL_IMAGE_ENDPOINT = "/api/local-image?path=";

/**
 * Image sources agents write as absolute paths (`/tmp/shot.png`, `file:///home/me/shot.png`) become
 * room-server URLs. Web URLs, data URLs, and the app's own routes pass through untouched.
 */
export function imageSource(src: string): string {
  if (src.startsWith("file://")) return LOCAL_IMAGE_ENDPOINT + encodeURIComponent(decodeURIComponent(src.slice("file://".length)));
  if (src.startsWith("/") && !src.startsWith("//") && !src.startsWith("/api/") && !src.startsWith("/assets/")) return LOCAL_IMAGE_ENDPOINT + encodeURIComponent(src);
  return src;
}
