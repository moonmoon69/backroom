Both features from the README's "Planned" section are in, and V reviewed both.

- **slugify** (W1): `slugify(text: string): string` in `src/text.ts`. ASCII letters are lowercased and kept, digits
  are kept, every run of other characters becomes one hyphen, and leading and trailing hyphens are dropped, so
  `"Hello, World!"` gives `"hello-world"` and `"Release 2.0 notes"` gives `"release-2-0-notes"`.
- **--json flag** (W2): `--json` anywhere on the command line makes `stats` print `{"lines":N,"words":N,"chars":N}`
  and `month-end` print `{"date":"YYYY-MM-DD","monthEnd":"YYYY-MM-DD"}`, each on one line. Without the flag the
  output is unchanged. `parseArgs` already collected flags, so the change is in `src/cli.ts` only.

`npm test` still reports the one failing `endOfMonth` test in `test/dates.test.ts`; it predates these changes and
neither feature touches `src/dates.ts`.
