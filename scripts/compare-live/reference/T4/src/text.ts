/**
 * Counts lines the way an editor numbers them: every "\n" ends a line, and text after the last "\n" is one more
 * line. The empty string has no lines.
 */
export function countLines(text: string): number {
  if (text === "") return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

/** Counts words: runs of characters other than whitespace. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

/**
 * Turns text into a URL slug: ASCII letters (lowercased) and digits are kept, every run of other characters becomes
 * a single hyphen, and there is no leading or trailing hyphen. "Hello, World!" gives "hello-world".
 */
export function slugify(text: string): string {
  return text
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
