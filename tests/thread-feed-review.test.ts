import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadFeed, type ThreadSnapshot } from "../src/adapter/threadFeed.ts";
import type { FeedConnection } from "../src/adapter/shellFeed.ts";

test("Astra: a full read answered after a newer bounded read must not resurrect stale history", async (t) => {
  let values: (items: unknown[]) => void = () => assert.fail("not subscribed");
  const connection: FeedConnection = {
    closed: false,
    heardAt: Date.now(),
    stream: (_tag, _payload, callback) => {
      values = callback;
      return { done: new Promise<void>(() => {}), cancel: () => {} };
    },
    ping: () => {},
    close: () => {},
  };
  let sequence = 7;
  let finishFull: (snapshot: ThreadSnapshot) => void = () => assert.fail("full read not started");
  let fullReads = 0;
  const feed = new ThreadFeed({
    read: async (_id, bounded) => {
      if (!bounded && ++fullReads === 1) return await new Promise<ThreadSnapshot>((resolve) => { finishFull = resolve; });
      return { snapshotSequence: sequence, projection: {} };
    },
    onChange: () => {},
    throttleMs: 0,
  });
  t.after(() => feed.close());
  feed.connect(connection);
  feed.lease("t");
  await new Promise(setImmediate);
  values([{ kind: "synchronized" }]);

  const oldFull = feed.detail("t", false);
  sequence = 8;
  values([{ kind: "event", sequence: 8 }]);
  await new Promise(setImmediate);
  assert.equal((await feed.detail("t", true))?.snapshotSequence, 8);
  finishFull({ snapshotSequence: 7, projection: {} });
  await oldFull;

  assert.equal((await feed.detail("t", false))?.snapshotSequence, 8,
    "the completed bounded read is newer: a later full caller must refresh instead of getting resurrected sequence 7");
});
