import assert from "node:assert/strict";
import { test } from "node:test";
import { followsBottom, STICK_PX } from "../web/src/boardFollow.ts";

test("the board follows its bottom until the reader scrolls up, not when the browser scrolls it down", () => {
  // Near the bottom it follows, whatever came before.
  assert.equal(followsBottom(false, 900, 1000, 0), true);
  assert.equal(followsBottom(false, 1000, 990, STICK_PX - 1), true);
  // The reader scrolls up past the margin: it stops.
  assert.equal(followsBottom(true, 1000, 900, 100), false);
  // The browser moves the board down by itself (scroll anchoring, as the status bar above opens a chip's choices)
  // and leaves it 43px short: it keeps following, and the board's resize brings it to the bottom.
  assert.equal(followsBottom(true, 3186, 3295, 43), true);
  // Scrolled up earlier and moved down without reaching the bottom: still not following.
  assert.equal(followsBottom(false, 2000, 2100, 300), false);
  // Not moved (a resize with no scroll): as it was.
  assert.equal(followsBottom(true, 1000, 1000, 80), true);
  assert.equal(followsBottom(false, 1000, 1000, 80), false);
});
