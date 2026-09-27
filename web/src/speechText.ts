/**
 * What a reply sounds like: its markdown as something worth hearing. Pure text, shared with the tests and free of
 * browser types; the speaking itself is in speech.ts.
 */
const basename = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
const looksLikePath = (code: string): boolean => /^[~.]?\/|^[A-Za-z]:\\|^[\w.-]+(\/[\w.-]+)+(:\d+)?$/.test(code) || /^[\w-]+\.[a-z]{1,5}(:\d+(:\d+)?)?$/i.test(code);

/**
 * A reply's markdown as something worth hearing: code blocks and tables are named rather than read, a path is its
 * file name, links are their text, and the markup is gone.
 */
export function speakable(markdown: string): string {
  let text = markdown.replace(/\r\n/g, "\n");
  text = text.replace(/```[\s\S]*?```/g, " A code block. ");
  text = text.replace(/~~~[\s\S]*?~~~/g, " A code block. ");
  // A table is its rows of pipes; say that it is there.
  text = text.replace(/(?:^[ \t]*\|.*\|[ \t]*\n?)+/gm, " A table. ");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt.trim() ? ` an image, ${alt.trim()}. ` : " an image. "));
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => (looksLikePath(code) ? ` ${basename(code.replace(/:\d+(:\d+)?$/, ""))} ` : ` ${code} `));
  text = text.replace(/https?:\/\/\S+/g, " a link ");
  text = text.replace(/<[^>\n]+>/g, " ");
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "");
  text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, " ");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  // A line that ends without punctuation is a sentence of its own when spoken.
  text = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;,…]$/.test(line) ? line : `${line}.`))
    .join(" ");
  return text.replace(/\s+/g, " ").trim();
}

const AUTO_MAX = 700;

/**
 * What is read when a reply arrives on its own: the Handoff section when the reply has one (it is written to be
 * passed on), otherwise the opening sentences, with a word that the rest is on screen.
 */
export function speakableSummary(markdown: string): string {
  const handoff = /^#{1,6}[ \t]+handoff\b[^\n]*\n([\s\S]*)$/im.exec(markdown) ?? /^\*\*handoff\*\*:?[ \t]*\n?([\s\S]*)$/im.exec(markdown);
  const text = speakable(handoff ? handoff[1]! : markdown);
  if (text.length <= AUTO_MAX) return text;
  const cut = text.slice(0, AUTO_MAX);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return `${end > AUTO_MAX / 2 ? cut.slice(0, end + 1) : cut} The rest is on screen.`;
}
