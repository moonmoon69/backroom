/** Hidden check for T4, W1's part: `slugify` in the copy's src/text.ts follows the README's spec (ASCII inputs only). */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const dir = process.env.FIXTURE_DIR;
if (!dir) throw new Error("FIXTURE_DIR is not set");
const text = (await import(pathToFileURL(join(dir, "src/text.ts")).href)) as { slugify?: unknown };

test("slugify is exported from src/text.ts", () => {
  assert.equal(typeof text.slugify, "function");
});

const cases: Array<[string, string]> = [
  ["Hello, World!", "hello-world"],
  ["  Many   spaces  ", "many-spaces"],
  ["already-slugged", "already-slugged"],
  ["a -- b", "a-b"],
  ["Release 2.0 notes", "release-2-0-notes"],
  ["--edge--", "edge"],
  ["", ""],
];

for (const [input, expected] of cases) {
  test(`slugify(${JSON.stringify(input)}) is ${JSON.stringify(expected)}`, () => {
    if (typeof text.slugify !== "function") assert.fail("slugify is not exported");
    assert.equal(text.slugify(input), expected);
  });
}
