# tally

Small back-office tools for a stationery shop: counts for text files, month-end dates, and the shop's product
catalog. Plain TypeScript run directly by Node 24; no dependencies, nothing to install.

## Commands

```sh
node src/cli.ts stats <file>             # line, word and character counts of a text file
node src/cli.ts month-end <YYYY-MM-DD>   # the last day of that date's month
```

`npm run tally -- stats notes.txt` does the same through npm. An unknown command prints the usage to stderr and
exits with code 2.

`stats` prints three lines:

```
lines: 12
words: 87
chars: 503
```

- **lines**: every `\n` ends a line, and text after the last `\n` counts as one more line; an empty file has 0 lines.
- **words**: runs of characters other than whitespace.
- **chars**: the length of the text as a JavaScript string (UTF-16 code units), newlines included.

`month-end 2026-04-10` prints `2026-04-30`.

## Layout

- `src/cli.ts`: the command line
- `src/args.ts`: splits arguments into positionals and `--flags`
- `src/text.ts`: line and word counts
- `src/format.ts`: renders `stats` output
- `src/dates.ts`: `YYYY-MM-DD` dates, month lengths, month-end and month arithmetic
- `src/catalog.ts`: the product catalog, one product per line
- `test/`: unit tests

## Tests

```sh
npm test
```

## Slow check

```sh
npm run slow-check
```

An integration check of the product catalog; it takes about three minutes. It prints its progress, then any
problems as `FAIL src/catalog.ts:<line> <message>`, and exits with code 1 if there were any. Each run appends a
`start` line and a `finish` line to `.slow-check.log`.

## Planned

- `slugify(text: string): string` in `src/text.ts`: lowercase ASCII letters and digits are kept (uppercase ASCII
  letters are lowercased); every run of other characters becomes a single hyphen; no leading or trailing hyphen.
  Example: `"Hello, World!"` -> `"hello-world"`.
- `--json` (anywhere on the command line) makes `stats` print one line of JSON `{"lines":N,"words":N,"chars":N}`
  and `month-end` print `{"date":"YYYY-MM-DD","monthEnd":"YYYY-MM-DD"}`; without the flag the output is unchanged.
