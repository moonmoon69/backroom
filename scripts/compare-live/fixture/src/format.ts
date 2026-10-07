import type { Stats } from "./types.ts";

/** Renders stats as one `name: value` line per count. */
export function formatStats(stats: Stats): string {
  return [`lines: ${stats.lines}`, `words: ${stats.words}`, `chars: ${stats.chars}`].join("\n");
}
