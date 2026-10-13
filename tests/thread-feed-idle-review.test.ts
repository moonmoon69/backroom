import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadFeed } from "../src/adapter/threadFeed.ts";
import type { FeedConnection } from "../src/adapter/shellFeed.ts";

test("Astra R2: a bounded refresh recovered after idle trimming still announces its change", async (t) => {
  // Production timings, with time advanced explicitly: idle 30s, failed-read retries after 5/10/20s.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  let values: (items: unknown[]) => void = () => assert.fail("not subscribed");
  const connection: FeedConnection = {
    closed: false,
    heardAt: Date.now(),
    stream: (_tag, _payload, callback) => {
      values = callback;
      return { done: new Promise<void>(() => {}), cancel: () => {} };
    },
    ping: () => {}, close: () => {},
  };
  let sequence = 7;
  let boundedFails = false;
  let boundedReads = 0;
  const changes: string[] = [];
  const feed = new ThreadFeed({
    read: async (_id, bounded) => {
      if (bounded) {
        boundedReads += 1;
        if (boundedFails) throw new Error("bounded GET temporarily returned HTTP 503");
      }
      return { snapshotSequence: sequence, projection: {} };
    },
    onChange: (id) => changes.push(id),
  });
  t.after(() => feed.close());
  const settle = () => new Promise(setImmediate);
  feed.connect(connection);
  feed.hold("engine", ["t1"]);
  await settle();
  values([{ kind: "synchronized" }]);
  await settle();
  assert.equal((await feed.detail("t1", true))?.snapshotSequence, 7);

  // A full-history caller reads T3's current sequence before its event arrives. This is ordinary HTTP/stream ordering.
  t.mock.timers.tick(2_000);
  sequence = 9;
  assert.equal((await feed.detail("t1", false))?.snapshotSequence, 9);
  boundedFails = true;
  values([{ kind: "event", sequence: 9 }]);
  await settle(); // The initial bounded refresh fails; retry at +5s.
  t.mock.timers.tick(5_000);
  await settle(); // Retry fails; next at +15s.
  t.mock.timers.tick(10_000);
  await settle(); // Retry fails; next at +35s.
  assert.equal(boundedReads, 4, "initial read plus three failed attempts");
  assert.equal(feed.pushed("t1"), true, "the thread socket remained healthy");

  t.mock.timers.tick(15_000); // +30s: quiet() drops bounded7 and retains full9.
  await settle();
  const state = (feed as unknown as { threads: Map<string, { cache: { bounded: unknown; full: { sequence: number } | null } }> }).threads.get("t1")!;
  assert.equal(state.cache.bounded, null, "memory trimming released the old bounded snapshot");
  assert.equal(state.cache.full?.sequence, 9);
  boundedFails = false;
  t.mock.timers.tick(5_000); // +35s: the retry succeeds and caches bounded9.
  await settle();
  assert.equal((await feed.detail("t1", true))?.snapshotSequence, 9);
  assert.equal(boundedReads, 5);
  assert.deepEqual(changes, ["t1"],
    "the page last read 7: successful recovery to 9 must push a thread event even though its old bounded snapshot was trimmed");
});
