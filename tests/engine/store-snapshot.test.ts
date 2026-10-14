/**
 * The store's two projection reads (Bug room #22): `snapshot`, one shared, deeply frozen object per journal head that the
 * host and the read API read without copying, and `project`, a detached copy the caller owns. Neither lets a reader
 * change the store, and neither changes under its reader when the journal grows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineStore, fold } from "../../src/engine/index.ts";
import type { Projection } from "../../src/engine/index.ts";
import { projectionMaps } from "../../src/engine/incremental.ts";
import { DiskRoom } from "./store-fixture.ts";

/** A room with one of everything a snapshot holds: requests with a correction, a run with a confirmed sync, a subscription. */
function busy(): { r: DiskRoom; runId: string } {
  const r = new DiskRoom();
  r.request("A");
  r.add({ type: "correct", actor: "O", requestId: "A", body: "Corrected A" });
  const run = r.reserve();
  r.request("B");
  const receipt = r.sync(run);
  r.add({ type: "confirm_sync", actor: "$system", runId: run.id, receiptId: receipt.id, digest: receipt.digest, evidence: "FAKE shown in the run" });
  r.add({ type: "subscribe", actor: "V", requestId: "A", milestones: ["m"], enabled: true });
  return { r, runId: run.id };
}

/** A snapshot as plain maps, sets and arrays, to compare with a fold. */
function plain(p: Projection): Projection {
  const out = { ...p, events: [...p.events], subscriptions: [...p.subscriptions], commandKeys: new Set(p.commandKeys) };
  for (const name of projectionMaps) (out[name] as Map<string, unknown>) = new Map(p[name] as Map<string, unknown>);
  return structuredClone(out);
}

/** Every kind of write a reader could try on a projection, nested ones included. */
function writes(p: Projection, runId: string): Array<[string, () => unknown]> {
  const run = p.runs.get(runId)!, seat = p.seats.get("W")!, request = p.requests.get("A")!, event = p.events[0]!, subscription = p.subscriptions[0]!;
  return [
    ["a map entry set", () => p.requests.set("Z", request)],
    ["a map entry deleted", () => p.seats.delete("W")],
    ["a map cleared", () => p.runs.clear()],
    ["a command key added", () => p.commandKeys.add("x")],
    ["an event appended", () => (p.events as unknown[]).push(event)],
    ["an event's data changed", () => { (event.data as { kind: string }).kind = "note"; }],
    ["a seat's cursor moved", () => { seat.cursor = 99; }],
    ["a request's correction appended", () => request.corrections.push({ eventId: "x", seq: 1, body: "x" })],
    ["a run's envelope input appended", () => run.envelope.inputs.push(run.envelope.inputs[0]!)],
    ["a receipt confirmed", () => { run.receipts[0]!.confirmed = false; }],
    ["a subscription appended", () => p.subscriptions.push({ seatId: "X", requestId: "A", milestones: [] })],
    ["a subscription's milestones changed", () => subscription.milestones.push("n")],
    ["the orchestrator replaced", () => { p.orchestrator = "W"; }],
  ];
}

test("snapshot: one frozen object per journal head, shared by every reader, equal to the journal's fold", () => {
  const { r } = busy();
  try {
    const first = r.store.snapshot(r.room);
    assert.equal(r.store.snapshot(r.room), first, "a read with no write in between hands out the same object");
    assert.deepEqual(plain(first), fold(r.store.load(r.room)));
    r.request("C");
    const second = r.store.snapshot(r.room);
    assert.notEqual(second, first, "a commit replaces the snapshot");
    assert.equal(second.requests.get("C")!.state, "open", "the read after a write sees it");
    assert.equal(first.requests.has("C"), false, "an earlier snapshot never changes");
    assert.equal(first.events.length, second.events.length - 1);
    assert.deepEqual(plain(second), fold(r.store.load(r.room)));
    r.parity();
  } finally { r.cleanup(); }
});

test("snapshot: every write to it throws, nested values included, and the store is unchanged", () => {
  const { r, runId } = busy();
  try {
    const p = r.store.snapshot(r.room);
    const before = r.store.project(r.room);
    for (const [what, write] of writes(p, runId)) assert.throws(write, TypeError, what);
    assert.deepEqual(r.store.project(r.room), before);
    assert.deepEqual(plain(p), before, "the snapshot itself is unchanged too");
    // The cache's own entries are frozen with it, so the next decision still copies before it changes one.
    r.add({ type: "correct", actor: "O", requestId: "A", body: "Corrected A again" });
    assert.equal(r.store.snapshot(r.room).requests.get("A")!.corrections.length, 2);
    assert.equal(p.requests.get("A")!.corrections.length, 1);
    r.parity();
  } finally { r.cleanup(); }
});

test("snapshot: its maps and sets are not Maps or Sets, so Map.prototype's and Set.prototype's writers cannot change them either (review #80)", () => {
  const { r } = busy();
  try {
    const p = r.store.snapshot(r.room), before = plain(p);
    for (const name of projectionMaps) {
      const map = p[name] as Map<string, unknown>, key = map.keys().next().value ?? "k";
      for (const [what, write] of [["set", () => Map.prototype.set.call(map, "forged", 1)], ["delete", () => Map.prototype.delete.call(map, key)], ["clear", () => Map.prototype.clear.call(map)]] as const) {
        assert.throws(write, TypeError, `Map.prototype.${what} on ${name}`);
      }
      assert.equal(map instanceof Map, false, name);
    }
    for (const [what, write] of [["add", () => Set.prototype.add.call(p.commandKeys, "forged")], ["delete", () => Set.prototype.delete.call(p.commandKeys, p.commandKeys.values().next().value)], ["clear", () => Set.prototype.clear.call(p.commandKeys)]] as const) {
      assert.throws(write, TypeError, `Set.prototype.${what} on commandKeys`);
    }
    assert.equal(p.commandKeys instanceof Set, false);
    assert.throws(() => { (Object.getPrototypeOf(p.seats) as { get: unknown }).get = () => undefined; }, TypeError, "nor can their shared methods be replaced");
    assert.deepEqual(plain(p), before, "the snapshot is unchanged");
    assert.equal(r.store.snapshot(r.room), p);
    assert.deepEqual(plain(r.store.snapshot(r.room)), fold(r.store.load(r.room)), "later readers agree with the journal");
    assert.deepEqual(r.store.project(r.room), fold(r.store.load(r.room)), "and so does a copy of it");
    // Read as a map and a set still: by key, by size, by iteration, and with forEach naming the view itself.
    assert.equal(p.seats.get("W")!.id, "W");
    assert.equal(p.seats.size, 4);
    assert.deepEqual([...p.seats.keys()], ["O", "W", "V", "X"]);
    assert.deepEqual(new Map(p.seats), r.store.project(r.room).seats);
    assert.equal([...p.commandKeys].length, p.commandKeys.size);
    p.seats.forEach((_seat, _id, map) => assert.equal(map, p.seats));
    p.commandKeys.forEach((_key, _again, set) => assert.equal(set, p.commandKeys));
  } finally { r.cleanup(); }
});

test("project: a detached copy the caller owns; changing it changes nothing else, and later commits leave it as it was", () => {
  const { r, runId } = busy();
  try {
    const mine = r.store.project(r.room);
    const shared = r.store.snapshot(r.room);
    const expected = plain(shared);
    for (const [what, write] of writes(mine, runId)) assert.doesNotThrow(write, what);
    assert.deepEqual(plain(r.store.snapshot(r.room)), expected, "the store and its snapshot are unchanged");
    assert.equal(r.store.snapshot(r.room), shared);
    const untouched = r.store.project(r.room);
    r.request("C");
    assert.equal(untouched.requests.has("C"), false);
    assert.equal(untouched.events.length, expected.events.length);
    assert.ok(Object.getPrototypeOf(untouched.seats) === Map.prototype && Object.getPrototypeOf(untouched.commandKeys) === Set.prototype, "plain maps and sets");
    assert.ok(!Object.isFrozen(untouched) && !Object.isFrozen(untouched.events) && !Object.isFrozen(untouched.requests.get("A")), "a writable copy");
    r.parity();
  } finally { r.cleanup(); }
});

test("snapshot: a foreign connection's commit is read before the snapshot is handed out", () => {
  const { r } = busy();
  const other = new EngineStore(r.path);
  try {
    const before = r.store.snapshot(r.room);
    other.execute(r.room, { type: "request", actor: "O", id: "F", to: "W", body: "From another connection" });
    const after = r.store.snapshot(r.room);
    assert.notEqual(after, before);
    assert.equal(after.requests.get("F")!.body, "From another connection");
    assert.equal(before.requests.has("F"), false);
    assert.deepEqual(plain(after), fold(r.store.load(r.room)));
  } finally { other.close(); r.cleanup(); }
});

test("snapshot: a write that fails before or after its commit leaves no snapshot that disagrees with the journal", () => {
  for (const fault of ["after_events", "before_commit", "after_commit", "before_cache_publish"] as const) {
    const { r } = busy();
    try {
      const before = r.store.snapshot(r.room);
      r.reopen({ onBoundary(point) { if (point === fault) throw new Error(`fault ${fault}`); } });
      const reopened = r.store.snapshot(r.room);
      assert.deepEqual(plain(reopened), plain(before), fault);
      assert.throws(() => r.request("C"), new RegExp(`fault ${fault}`));
      const after = r.store.snapshot(r.room);
      const committed = ["after_commit", "before_cache_publish"].includes(fault);
      assert.equal(after.requests.has("C"), committed, fault);
      assert.notEqual(after, reopened, `${fault}: the failed write dropped the cache, and its snapshot with it`);
      assert.deepEqual(plain(after), fold(r.store.load(r.room)), fault);
      assert.equal(reopened.requests.has("C"), false, `${fault}: a snapshot handed out before stays as it was`);
      r.reopen();
      r.parity();
    } finally { r.cleanup(); }
  }
});

test("snapshot: a rebuild replaces it", () => {
  const { r } = busy();
  try {
    const before = r.store.snapshot(r.room);
    r.store.rebuild(r.room);
    const after = r.store.snapshot(r.room);
    assert.notEqual(after, before);
    assert.deepEqual(plain(after), plain(before));
    r.parity();
  } finally { r.cleanup(); }
});
