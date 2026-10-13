import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run the real useDesk hook's effects once; no DOM is needed for its event/timer wiring.
const root = fileURLToPath(new URL('../..', import.meta.url));
const effects = [];
const stateWrites = [];
mock.module(pathToFileURL(`${root}/node_modules/react/index.js`).href, {
  namedExports: {
    useEffect: (effect) => effects.push(effect),
    useRef: (current) => ({ current }),
    useState: (initial) => [initial, (next) => stateWrites.push(next)],
  },
});
const { useDesk, api, pagePush } = await import(pathToFileURL(`${root}/web/src/api.ts`).href);
const { withPush } = await import(pathToFileURL(`${root}/web/src/pageStream.ts`).href);

test('the open empty room learns a new member desk before its 60-second fallback', async () => {
  const timers = new Map();
  let timerId = 0;
  globalThis.window = {
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  let reads = 0;
  let reply = { participants: {}, errors: {}, fetchedAt: 'before', pushed: true };
  api.desk = async () => { reads += 1; return reply; };
  pagePush.setOpen(true);
  useDesk('room', 10_000);
  const cleanups = effects.map((effect) => effect()).filter(Boolean);
  try {
    await new Promise(setImmediate);
    assert.equal(reads, 1);
    assert.deepEqual([...timers.values()].map((timer) => timer.ms), [60_000]);

    // The room acquired its first member, and that member produced live output.
    reply = { participants: { member: { threadId: 'new-thread', pushed: true, liveFeed: ['working'] } }, errors: {}, fetchedAt: 'after', pushed: true };
    let snapshotReads = 0;
    const handlers = withPush({
      all() {}, rooms() {},
      room: (id) => { if (id === 'room') snapshotReads += 1; },
      shell() {}, status() {},
    }, pagePush, () => {});
    handlers.room('room');
    handlers.thread('new-thread');
    await new Promise(setImmediate);
    assert.equal(snapshotReads, 1, 'the room snapshot did refresh');
    assert.ok(reads > 1, 'desk must learn the new thread before the fallback timer; currently all of its pushed events are discarded');
    assert.ok(stateWrites.some((value) => value?.participants?.member?.threadId === 'new-thread'), 'the fresh desk is applied');
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
});
