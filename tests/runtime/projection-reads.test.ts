/**
 * The host's projection reads (Bug room #22): on the live service the Tests room (4,220 events, 67 seats) spent most of
 * each tick copying the whole projection, once for each of the host's several reads per seat per pass. A tick now reads
 * the store's shared snapshot: no projection is copied, and the host sees one projection per journal head, so an idle
 * tick sees one and a writing tick one more per commit. Each read after a write, the host's own or a command that landed
 * while the tick waited on T3, still sees it.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fold, inputTree } from "../../src/engine/index.ts";
import type { CommitReceipt, EngineStore, Projection } from "../../src/engine/index.ts";
import { HostRefusal, MEMBERS_DO_NOT_POST } from "../../src/runtime/index.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

const SEATS = ["C", ...Array.from({ length: 59 }, (_, i) => `W${i + 1}`)];

/**
 * Counts, from now until `stop`, what the host is handed by the store: every distinct projection object (whichever read
 * returned it), every whole projection copied (a structuredClone of one), and every commit that appended.
 */
function watchReads(store: EngineStore) {
  const seen = new Set<Projection>();
  let copies = 0, commits = 0;
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = ((value: unknown, options?: Parameters<typeof structuredClone>[1]) => {
    if (value && typeof value === "object" && "seats" in value && "events" in value) copies += 1;
    return clone(value, options);
  }) as typeof structuredClone;
  const target = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = new Map<string, (...args: unknown[]) => unknown>();
  for (const name of ["project", "snapshot", "execute"]) {
    const original = target[name];
    if (typeof original !== "function") continue;
    originals.set(name, original);
    target[name] = (...args: unknown[]) => {
      const result = original.apply(store, args);
      if (name === "execute") {
        const receipt = result as CommitReceipt;
        if (!receipt.replayed && receipt.events.length > 0) commits += 1;
      } else seen.add(result as Projection);
      return result;
    };
  }
  return {
    get projections() { return seen.size; },
    get copies() { return copies; },
    get commits() { return commits; },
    stop() {
      globalThis.structuredClone = clone;
      for (const [name, original] of originals) target[name] = original;
    },
  };
}

/** Sixty seats, the orchestrator C asking the app's per-seat watch for the room as the seat lifecycle does, and some history. */
async function bigRoom(): Promise<Room> {
  const r: Room = await Room.create({ seats: SEATS, host: { watch: (at) => void r.host.view(at.roomId) } });
  for (const seat of ["W1", "W2", "W3"]) r.user(seat, `Earlier work for ${seat}.`);
  await r.tick();
  for (const seat of ["W1", "W2", "W3"]) r.complete(seat, `Done, ${seat}.`);
  await r.tick(2);
  return r;
}

test("an idle tick over sixty seats copies no projection and is handed one", async () => {
  room = await bigRoom();
  const reads = watchReads(room.store);
  try {
    await room.tick();
    assert.equal(reads.commits, 0, "nothing to do");
    assert.equal(reads.copies, 0, "no whole projection is copied");
    assert.equal(reads.projections, 1, "every read of the tick is the same projection");
  } finally { reads.stop(); }
});

test("a writing tick is handed one projection per commit, and every read after a write sees it: reserve, send and accept, then output and end", async () => {
  room = await bigRoom();
  const asked = ["W4", "W5", "W6", "W7", "W8"];
  const ids = asked.map((seat) => room.user(seat, `Look at ${seat}.`));
  let reads = watchReads(room.store);
  const steps = room.steps.length;
  try {
    await room.tick();
    assert.equal(reads.copies, 0);
    assert.ok(reads.commits >= asked.length * 3, `reserve, sending and accepted per seat (${reads.commits} commits)`);
    assert.ok(reads.projections <= reads.commits + 1, `${reads.projections} projections for ${reads.commits} commits`);
  } finally { reads.stop(); }
  for (const seat of asked) assert.equal(room.running(seat), true, `${seat} is in its turn after one tick`);
  assert.deepEqual(room.steps.slice(steps).filter((s) => s === "accepted").length, asked.length);
  for (const seat of asked) room.complete(seat, `Answer from ${seat}.`);
  reads = watchReads(room.store);
  try {
    await room.tick();
    assert.equal(reads.copies, 0);
    assert.ok(reads.projections <= reads.commits + 1, `${reads.projections} projections for ${reads.commits} commits`);
  } finally { reads.stop(); }
  for (const id of ids) assert.equal(room.state(id), "answered", `${id} is answered in the same tick its turn ended`);
  assert.deepEqual(room.unresolvedRuns(), []);
});

test("commands that land while a tick waits on T3 are read by the rest of that tick; nothing is sent twice", async () => {
  room = await Room.create({ seats: ["C", "W", "V"] });
  await room.tick();
  const a = room.user("W", "A: fix dates.ts.");
  let b = "", correction = "";
  room.fake.onDetail = {
    threadId: room.threadOf("W"),
    run: () => {
      // As HTTP commands do: they are committed while the tick waits on the thread read.
      b = room.user("V", "B: fix text.ts.");
      correction = room.id("correct");
      room.host.correct(room.room, { actor: "$user", id: correction, requestId: a, body: "A: fix dates.ts and its test." });
      room.host.designate(room.room, { id: room.id("designate"), seatId: "V" });
    },
  };
  await room.tick();
  assert.ok(b, "the commands landed during the tick");
  assert.equal(room.running("W"), true);
  assert.equal(room.running("V"), true, "V's request, landed mid-tick, is sent in the same tick");
  assert.match(room.prompt("V"), /B: fix text\.ts/);
  // The correction, landed after W's run was reserved, goes into W's running turn in the same tick (M1).
  const wRun = room.p.runs.get(room.p.seats.get("W")!.activeRunId!)!;
  assert.ok(wRun.receipts.some((r) => inputTree(r.envelope.inputs).some((i) => i.eventId === correction)), "the correction is offered to W's turn");
  for (const seat of ["W", "V"]) {
    const sent = room.fake.attempts.filter((x) => x.threadId === room.threadOf(seat)).map((x) => x.messageId);
    assert.equal(new Set(sent).size, sent.length, `nothing is sent to ${seat} twice`);
  }
  assert.equal(room.fake.attempts.filter((x) => x.threadId === room.threadOf("W")).length, 2, "W's message, then the correction into its turn");
  assert.equal(room.fake.attempts.filter((x) => x.threadId === room.threadOf("V")).length, 1);
  assert.equal(room.p.orchestrator, "V");
  // Who may post is read from the room as it is now: V, designated mid-tick, is the orchestrator; C no longer is.
  assert.throws(() => room.host.request(room.room, { actor: "C", id: room.id("c"), to: "W", body: "C asks." }), (e: unknown) => e instanceof HostRefusal && e.message === MEMBERS_DO_NOT_POST);
  room.host.request(room.room, { actor: "V", id: room.id("v"), to: "W", body: "V asks." });
  room.complete("W", "Fixed dates.ts.");
  room.complete("V", "Fixed text.ts.");
  await room.until(() => room.state(a) === "answered" && room.state(b) === "answered");
  assert.equal(room.outputs().filter((o) => o.claims.some((c) => c.requestId === a && c.outcome === "answered")).length, 1, "A is answered once");
});

test("view: the host's own snapshot, which refuses every write and never changes when the room does", async () => {
  room = await Room.create({ seats: ["C", "W", "V"] });
  const a = room.user("W", "A: fix dates.ts.");
  await room.tick();
  const view = room.host.view(room.room);
  assert.equal(room.host.view(room.room), view, "no copy per read");
  const run = view.runs.get(view.seats.get("W")!.activeRunId!)!;
  assert.throws(() => { view.requests.get(a)!.state = "cancelled"; }, TypeError);
  assert.throws(() => run.envelope.inputs.push(run.envelope.inputs[0]!), TypeError);
  assert.throws(() => view.seats.delete("W"), TypeError);
  assert.equal(room.p.requests.get(a)!.state, "open", "the store is unchanged");
  room.complete("W", "Fixed dates.ts.");
  await room.tick();
  assert.equal(room.state(a), "answered");
  assert.equal(view.requests.get(a)!.state, "open", "a view handed out before is as it was");
  assert.notEqual(room.host.view(room.room), view);
});

// Review #80: a caller's view whose maps or sets it changed through Map.prototype or Set.prototype poisoned every later
// read, the host's included: the snapshot's maps and sets now have no Map or Set inside them to change.
for (const kind of ["map", "set"] as const) test(`native ${kind} writers on a caller's view cannot poison later readers`, async () => {
  room = await Room.create({ seats: ["C", "W"] });
  const q = room.user("W", "Run the requested work.");
  const view = room.host.view(room.room);
  assert.throws(() => (kind === "map" ? Map.prototype.clear.call(view.seats) : Set.prototype.add.call(view.commandKeys, "not-in-the-journal")), TypeError);
  const next = room.host.view(room.room);
  const replay = fold(room.store.load(room.room));
  if (kind === "map") {
    assert.equal(next.seats.size, 2);
    await room.tick();
    assert.equal(room.running("W"), true, "a caller cannot stop dispatch by changing its view");
  } else assert.deepEqual([...next.commandKeys], [...replay.commandKeys], "later readers agree with the journal");
  assert.equal(room.state(q), "open");
});
