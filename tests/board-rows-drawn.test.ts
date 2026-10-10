import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// C1: with the board scrolled up, its rows out of view skipped by content-visibility: auto, a turn that ends stopped or
// failed crashed Chrome's renderer (Chrome 155: a CHECK, the tab gone). The page's styles draw every row in full.
test("no style of the page skips drawing what is out of view (content-visibility)", () => {
  for (const file of ["styles.css", "pixel.css"]) {
    const css = readFileSync(new URL(`../web/src/${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /content-visibility\s*:/, `${file} sets content-visibility`);
  }
});
