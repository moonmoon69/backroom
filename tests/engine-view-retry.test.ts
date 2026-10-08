/**
 * Retry on a failed run's notice (the read API's rule, src/server/engineView.ts; the page's button follows it): offered
 * while one of the run's requests is still open, never once they are all closed. Retrying then would spend a turn on
 * work nobody asks for any more (L5 review round 1, B2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { journalView } from "../src/server/engineView.ts";
import { Room } from "./runtime/helpers.ts";

test("a failed run's notice offers Retry while its request is open, and not once the request is cancelled", async (t) => {
  const room = await Room.create({ orchestrator: null });
  t.after(() => room.close());
  const asked = room.user("W", "Tag the release.");
  await room.until(() => room.running("W"));
  room.complete("W", "the provider failed", { outcome: "error" });
  await room.until(() => room.notices().length > 0 && room.unresolvedRuns().length === 0);

  const notice = () => journalView({ p: room.p }).posts.find((post) => post.kind === "notice" && post.about.some((r) => r.requestId === asked))!;
  assert.ok(notice(), "the failure is on the board");
  assert.ok(notice().notice!.retryRunId, "Retry is offered while the request is open");
  assert.equal(notice().notice!.needsYou, true);

  room.cancel("$user", asked);
  assert.equal(room.state(asked), "cancelled");
  assert.equal(notice().notice!.retryRunId, null, "no Retry once every request of the run is closed");
  assert.equal(notice().notice!.needsYou, false, "and it no longer waits on the user");
});
