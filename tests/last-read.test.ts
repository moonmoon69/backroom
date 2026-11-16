import assert from "node:assert/strict";
import { test } from "node:test";
import { heldTop, lastReadLine, READ_ABOVE } from "../web/src/lastRead.ts";

const post = (seq: number, author = "seat-1") => [{ seq, author }];

test("the new line goes over the first item after the mark that is not the user's own", () => {
  const items = [post(1), post(2, "$user"), post(3), [], post(4, "$user"), post(5), post(6)];
  // Seen up to 3: the user's own message after it and the day's separator are passed over.
  assert.deepEqual(lastReadLine(items, 3, 40), { over: 5, shown: 40 });
  // A message to several members is one item: its first post says whose it is and where it stands.
  assert.deepEqual(lastReadLine([post(1), [{ seq: 2, author: "$user" }, { seq: 3, author: "$user" }], post(4)], 1, 40)?.over, 2);
  // The system's posts are not the user's.
  assert.equal(lastReadLine([post(1), post(2, "$system")], 1, 40)?.over, 1);
});

test("nothing new in the view draws no line", () => {
  assert.equal(lastReadLine([post(1), post(2)], 2, 40), null);
  assert.equal(lastReadLine([post(1), post(2, "$user")], 1, 40), null);
  assert.equal(lastReadLine([], 0, 40), null);
});

test("the drawn window widens to hold the line and a little of what was read above it", () => {
  const items = Array.from({ length: 100 }, (_, index) => post(index + 1));
  // The first new post is the 31st of 100: the latest 40 do not hold it.
  assert.deepEqual(lastReadLine(items, 30, 40), { over: 30, shown: 70 + READ_ABOVE });
  // A window that holds it already stays as it is.
  assert.deepEqual(lastReadLine(items, 90, 40), { over: 90, shown: 40 });
});

test("a first new post older than the posts read puts the line over the first one read", () => {
  const items = [post(50, "$user"), post(51), post(52)];
  assert.equal(lastReadLine(items, 10, 40)?.over, 1);
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
