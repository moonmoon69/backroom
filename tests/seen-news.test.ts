/** The overview's thread news, less what the page has marked seen since its last read (web/src/seenNews.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { newsUnlessSeen } from "../web/src/seenNews.ts";

test("a thread marked seen on the page has no news in the overview's read until a later finish", () => {
  const news = { at: "2026-10-11T12:00:00.000Z", state: "completed" as const };
  // The overview read it before the mark landed: what was marked is left out at once, not at the next read.
  assert.equal(newsUnlessSeen(news, "2026-10-11T12:00:00.000Z"), null);
  assert.equal(newsUnlessSeen(news, "2026-10-11T12:05:00.000Z"), null, "marked up to a later finish");
  // A finish after the mark is news again; nothing marked keeps the read's news.
  assert.deepEqual(newsUnlessSeen({ ...news, at: "2026-10-11T12:10:00.000Z" }, "2026-10-11T12:05:00.000Z"), { ...news, at: "2026-10-11T12:10:00.000Z" });
  assert.deepEqual(newsUnlessSeen(news, undefined), news);
  assert.equal(newsUnlessSeen(null, "2026-10-11T12:00:00.000Z"), null);
});
