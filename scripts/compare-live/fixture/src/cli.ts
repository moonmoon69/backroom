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
 */

const USAGE = "usage: tally stats <file>\n       tally month-end <YYYY-MM-DD>";

/** Runs one command and returns the exit code. */
function main(argv: readonly string[]): number {
  const { positionals } = parseArgs(argv);
  const [command, operand] = positionals;

  if (command === "stats" && operand !== undefined) {
    const text = readFileSync(operand, "utf8");
    const stats: Stats = { lines: countLines(text), words: countWords(text), chars: text.length };
    console.log(formatStats(stats));
    return 0;
  }

  if (command === "month-end" && operand !== undefined) {
    console.log(endOfMonth(operand));
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
