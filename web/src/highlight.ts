/**
 * Code highlighting for file previews with Shiki, the highlighter T3 Code uses. It is loaded only when a preview
 * opens (with its JavaScript regex engine, so no WebAssembly), and a language's grammar only when a file needs it.
 */
import type { BundledLanguage, BundledTheme, HighlighterGeneric } from "shiki";

const THEMES = { dark: "github-dark-default", light: "github-light-default" } as const;

/** Extensions Shiki knows by another name. The rest are tried as they are, and fall back to plain text. */
const EXTENSION_LANGUAGES: Record<string, string> = {
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  svg: "xml",
  htm: "html",
  txt: "text",
  lock: "text",
};

/** Beyond this, the file is shown as plain text: highlighting would stall the page. */
const MAX_HIGHLIGHT_CHARS = 300_000;

/** Shiki's language for a file: by extension, a few by name; "text" when it has none. */
export function languageOf(fileName: string): string {
  const name = fileName.toLowerCase();
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return "docker";
  if (name === "makefile") return "make";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return EXTENSION_LANGUAGES[extension] ?? (extension || "text");
}

let highlighter: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | null = null;

/**
 * The file as HTML: one `<span class="line">` per line, coloured for both themes (CSS picks one), the target lines
 * (`from` to `to`) marked. Null when it cannot be highlighted (too long, or Shiki could not load); the preview then
 * shows plain text.
 */
export async function highlightCode(code: string, fileName: string, from?: number, to: number | undefined = from): Promise<string | null> {
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    const shiki = await import("shiki");
    const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
    highlighter ??= shiki.createHighlighter({ themes: [THEMES.dark, THEMES.light], langs: [], engine: createJavaScriptRegexEngine() });
    const loaded = await highlighter;
    let lang = languageOf(fileName);
    if (!(lang in shiki.bundledLanguages)) lang = "text";
    if (lang !== "text" && !loaded.getLoadedLanguages().includes(lang)) await loaded.loadLanguage(lang as BundledLanguage);
    return loaded.codeToHtml(code, {
      lang,
      themes: THEMES,
      defaultColor: false,
      transformers: [
        {
          line(node, line) {
            if (from !== undefined && to !== undefined && line >= from && line <= to) this.addClassToHast(node, "target");
          },
        },
      ],
    });
  } catch {
    return null;
  }
}
