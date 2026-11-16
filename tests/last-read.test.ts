import assert from "node:assert/strict";
import { test } from "node:test";
import { heldTop, lastReadLine, READ_ABOVE, windowStart } from "../web/src/lastRead.ts";

const post = (seq: number, author = "seat-1") => [{ seq, author }];

test("the new line goes over the first item after the mark that is not the user's own", () => {
  const items = [post(1), post(2, "$user"), post(3), [], post(4, "$user"), post(5), post(6)];
  // Seen up to 3: the user's own message after it and the day's separator are passed over.
  assert.equal(lastReadLine(items, 3), 5);
  // A message to several members is one item: its first post says whose it is and where it stands.
  assert.equal(lastReadLine([post(1), [{ seq: 2, author: "$user" }, { seq: 3, author: "$user" }], post(4)], 1), 2);
  // The system's posts are not the user's.
  assert.equal(lastReadLine([post(1), post(2, "$system")], 1), 1);
});

test("nothing new in the view draws no line", () => {
  assert.equal(lastReadLine([post(1), post(2)], 2), null);
  assert.equal(lastReadLine([post(1), post(2, "$user")], 1), null);
  assert.equal(lastReadLine([], 0), null);
});

test("a first new post older than the posts read puts the line over the first one read", () => {
  assert.equal(lastReadLine([post(50, "$user"), post(51), post(52)], 10), 1);
});

test("with no start the window is the latest items, and a line has it start a little above", () => {
  const items = Array.from({ length: 100 }, (_, index) => post(index + 1));
  assert.equal(windowStart(items, null, 40, null), 60);
  // The line over the 31st of 100: the latest 40 do not hold it.
  assert.equal(windowStart(items, null, 40, 30), 30 - READ_ABOVE);
  // A window that holds the line already stays as it is; a line at the view's start has nothing above it.
  assert.equal(windowStart(items, null, 40, 90), 60);
  assert.equal(windowStart(items, null, 40, 1), 0);
  // Fewer items than the limit, or no limit: all of them.
  assert.equal(windowStart(items.slice(0, 10), null, 40, null), 0);
  assert.equal(windowStart(items, null, 0, null), 0);
});

test("a window that starts at a seq stays there whatever lands, and whichever line comes or goes", () => {
  const items = Array.from({ length: 100 }, (_, index) => post(index + 1));
  assert.equal(windowStart(items, 61, 40, null), 60);
  // Posts landed: the start is where it was, and the window longer.
  const more = [...items, ...Array.from({ length: 70 }, (_, index) => post(index + 101))];
  assert.equal(windowStart(more, 61, 40, null), 60);
  // A line that was above the start has gone to a later post: nothing drawn is dropped.
  assert.equal(windowStart(more, 28, 40, 100), 27);
  // A line above the start moves it earlier.
  assert.equal(windowStart(more, 61, 40, 30), 30 - READ_ABOVE);
  // The start's own post gone from the view (a page read anew): the first one after it.
  assert.equal(windowStart(more.slice(80), 61, 40, null), 0);
});

test("the window starts with the day's separator over its first post", () => {
  const items = [post(1), [], post(2), post(3), [], post(4)];
  assert.equal(windowStart(items, 2, 40, null), 1);
  assert.equal(windowStart(items, null, 1, null), 4);
  assert.equal(windowStart(items, null, 2, null), 4);
  assert.equal(windowStart(items, 3, 40, null), 3);
});

test("following the bottom never carries a held line above its place", () => {
  // No line held: the bottom.
  assert.deepEqual(heldTop(900, null), { top: 900, following: true });
  // The news fits the screen: the bottom, still following.
  assert.deepEqual(heldTop(900, 1100), { top: 900, following: true });
  assert.deepEqual(heldTop(900, 900), { top: 900, following: true });
  // It grew past the screen (images loaded, a new post): the line's place, following off.
  assert.deepEqual(heldTop(2340, 1100), { top: 1100, following: false });
  // A line nearer the board's start than its place: the start.
  assert.deepEqual(heldTop(500, -40), { top: 0, following: false });
});
