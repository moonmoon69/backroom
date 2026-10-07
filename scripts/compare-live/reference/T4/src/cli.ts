import { readFileSync } from "node:fs";
import { parseArgs } from "./args.ts";
import { countLines, countWords } from "./text.ts";
import { formatStats } from "./format.ts";
import { endOfMonth } from "./dates.ts";
import { legacyBanner } from "./legacy.ts";
import type { Stats } from "./types.ts";

/*
 * tally's command line.
 *
 *   tally stats <file>              line, word and character counts of a text file
 *   tally month-end <YYYY-MM-DD>    the last day of that date's month
 *
 * With --json anywhere on the line, either command prints one line of JSON instead.
 */

const USAGE = "usage: tally stats <file> [--json]\n       tally month-end <YYYY-MM-DD> [--json]";

/** Runs one command and returns the exit code. */
function main(argv: readonly string[]): number {
  const { positionals, flags } = parseArgs(argv);
  const [command, operand] = positionals;
  const json = flags.has("json");

  if (command === "stats" && operand !== undefined) {
    const text = readFileSync(operand, "utf8");
    const stats: Stats = { lines: countLines(text), words: countWords(text), chars: text.length };
    console.log(json ? JSON.stringify(stats) : formatStats(stats));
    return 0;
  }

  if (command === "month-end" && operand !== undefined) {
    const monthEnd = endOfMonth(operand);
    console.log(json ? JSON.stringify({ date: operand, monthEnd }) : monthEnd);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`tally: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
