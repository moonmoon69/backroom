`src/cli.ts` imports seven modules, one per line at the top of the file. A subagent read each imported file and
checked every imported name against the body of `cli.ts`:

| Import | Names | Used in cli.ts |
| --- | --- | --- |
| `src/cli.ts:1` `node:fs` | `readFileSync` | yes, `src/cli.ts:24` reads the file for `stats` |
| `src/cli.ts:2` `./args.ts` | `parseArgs` | yes, `src/cli.ts:20` |
| `src/cli.ts:3` `./text.ts` | `countLines`, `countWords` | yes, `src/cli.ts:25` |
| `src/cli.ts:4` `./format.ts` | `formatStats` | yes, `src/cli.ts:26` |
| `src/cli.ts:5` `./dates.ts` | `endOfMonth` | yes, `src/cli.ts:31` |
| `src/cli.ts:6` `./legacy.ts` | `legacyBanner` | no |
| `src/cli.ts:7` `./types.ts` | `type Stats` | yes, the annotation at `src/cli.ts:25` |

One import is unused: `legacyBanner` from `./legacy.ts` at `src/cli.ts:6` is imported but never called anywhere in
`cli.ts` (`src/legacy.ts:2` defines it). The other six are all used.
