import assert from "node:assert/strict";
import { test } from "node:test";
import { countLines, countWords } from "../src/text.ts";

test("countLines counts a final line without a newline", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\ntwo"), 2);
  assert.equal(countLines("one\ntwo\n"), 2);
  assert.equal(countLines("\n\n"), 2);
});

test("countWords splits on any whitespace", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   "), 0);
  assert.equal(countWords("hello"), 1);
  assert.equal(countWords("  hello,   world \n\tagain\n"), 3);
});
