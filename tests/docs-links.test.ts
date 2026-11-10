/**
 * Every relative link, image and #anchor in README.md and the files under docs/ resolves: the file exists, and an
 * anchor names a heading of the Markdown file it points into, slugged as GitHub slugs headings.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = ["README.md", ...readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];

/** The text outside fenced code blocks and inline code, where a link is a link. */
function prose(text: string): string {
  return text.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
}

/** GitHub's anchors for a file's headings: lower case, punctuation dropped, spaces as hyphens, repeats numbered. */
export function anchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const [, heading] of text.replace(/^```[\s\S]*?^```/gm, "").matchAll(/^#{1,6} (.+?)\s*$/gm)) {
    const base = heading!
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replaceAll("`", "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "")
      .replaceAll(" ", "-");
    const n = seen.get(base) ?? 0;
    out.add(n === 0 ? base : `${base}-${n}`);
    seen.set(base, n + 1);
  }
  return out;
}

/** Every link target in a file: Markdown links and images, and the src or href of an HTML tag. */
function targets(text: string): string[] {
  const body = prose(text);
  return [...body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g), ...body.matchAll(/<(?:img|a)\b[^>]*?\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
}

test("the slug rule gives GitHub's anchors", () => {
  assert.deepEqual([...anchors("# A title\n## The board, and `bin/rooms-board`\n## Try it without T3 (demo mode)\n## A title\n```\n# not a heading\n```\n")], [
    "a-title",
    "the-board-and-binrooms-board",
    "try-it-without-t3-demo-mode",
    "a-title-1",
  ]);
});

test("every relative link, image and anchor in README.md and docs resolves", () => {
  const broken: string[] = [];
  for (const file of docs) {
    const text = readFileSync(join(root, file), "utf8");
    for (const target of targets(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [path = "", fragment] = target.split("#", 2) as [string, string | undefined];
      const into = path === "" ? join(root, file) : resolve(dirname(join(root, file)), decodeURI(path));
      if (!existsSync(into)) {
        broken.push(`${file}: ${target} (no ${relative(root, into)})`);
        continue;
      }
      if (fragment !== undefined && into.endsWith(".md") && !anchors(readFileSync(into, "utf8")).has(fragment)) {
        broken.push(`${file}: ${target} (no heading #${fragment} in ${relative(root, into)})`);
      }
    }
  }
  assert.deepEqual(broken, []);
});
