/** A command line split into its positional arguments and its `--flags`. */
export interface ParsedArgs {
  /** Arguments that are not flags, in the order given. */
  positionals: string[];
  /** Flag names without the leading dashes, e.g. `verbose` for `--verbose`. */
  flags: Set<string>;
}

/**
 * Splits command-line arguments. Any argument that starts with `--` (and has a name after it) is a flag and may
 * appear anywhere; everything else is positional.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  for (const arg of argv) {
    if (arg.startsWith("--") && arg.length > 2) flags.add(arg.slice(2));
    else positionals.push(arg);
  }
  return { positionals, flags };
}
