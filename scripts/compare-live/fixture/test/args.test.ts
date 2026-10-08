import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";

test("parseArgs separates positionals from flags", () => {
  const parsed = parseArgs(["stats", "--verbose", "notes.txt"]);
  assert.deepEqual(parsed.positionals, ["stats", "notes.txt"]);
  assert.deepEqual([...parsed.flags], ["verbose"]);
});

test("parseArgs treats a single dash and a bare double dash as positionals", () => {
  const parsed = parseArgs(["-", "--"]);
  assert.deepEqual(parsed.positionals, ["-", "--"]);
  assert.equal(parsed.flags.size, 0);
});
