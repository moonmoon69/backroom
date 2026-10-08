/**
 * L6 gate: the lean core replays every golden history with the same decisions and the same kept projection maps.
 * The goldens (tests/engine/golden/*.json) were recorded from the core as merged, before the carve (commit 82f3d630,
 * made by tests/engine/golden/generate.ts there): each step is a command with the decision `decide` returned or its
 * refusal, and each history ends with the kept maps in canonical JSON.
 *
 * The plan's two exceptions, and only what follows from them and from §6's dropped fields:
 * - Control events are left out. Steps marked `leftOut` (the host's `control_phase`) are not replayed, `control.*`
 *   events are not expected, and their command keys are not in `commandKeys`. Every sequence-number field after a
 *   left-out event is renumbered (event seq, expectedSeq, request version, correction seq, envelope base, through and
 *   contextThrough, input seq, run and activity through, seat cursor, transfer cutoff). A sync receipt's digest covers
 *   its envelope and would need recomputing; no golden history has a sync after a left-out event, and the test asserts
 *   that. The control's one other effect on the kept maps, the seat status `stopping`, reads as `active`.
 * - The T3 run ID is compared as a field: a `phase` whose evidence starts `t3run:<id>` carries `providerRunId: <id>`,
 *   and so do its `run.phase` event and its run.
 * - `Request.live`, dropped by §6, is null in every golden history and is not compared.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decide, EngineStore, fold } from "../../src/engine/index.ts";
import type { Command, Decision, Projection, RoomEvent } from "../../src/engine/index.ts";

interface Step { command: Command; leftOut?: "control"; expect: { outcome: Decision["outcome"]; expectedSeq: number; events: RoomEvent[] } | { error: string }; store?: { error: string } | { outcome: string } }
interface KeptMaps {
  seats: [string, Record<string, unknown>][]; requests: [string, Record<string, unknown>][]; runs: [string, Record<string, unknown>][];
  activities: [string, unknown][]; subscriptions: unknown[]; sourceKeys: [string, string][]; commandKeys: string[]; blocked: [string, string][]; orchestrator: string | null;
}
interface Sequence { name: string; steps: Step[]; maps: KeptMaps }

const dir = join(import.meta.dirname, "golden");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

/** Sorted keys, undefined dropped. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter((k) => object[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`).join(",")}}`;
}
const plain = <T>(value: T): T => JSON.parse(canonical(value)) as T;

export function keptMaps(p: Projection): KeptMaps {
  const sorted = <V>(map: Map<string, V>): [string, V][] => [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, plain(v)]);
  return plain({
    seats: sorted(p.seats), requests: sorted(p.requests), runs: sorted(p.runs), activities: sorted(p.activities),
    subscriptions: p.subscriptions, sourceKeys: sorted(p.sourceKeys), commandKeys: [...p.commandKeys].sort(), blocked: sorted(p.blocked),
    orchestrator: p.orchestrator,
  }) as unknown as KeptMaps;
}

const t3RunOf = (command: Command): string | undefined =>
  command.type === "phase" && ["accepted", "running", "uncertain"].includes(command.phase) ? /^t3run:(\S+)/.exec(command.evidence)?.[1] : undefined;

/** Fields that hold a journal sequence number, in events, decisions, envelopes and projection entries. */
const SEQ_FIELDS = new Set(["seq", "version", "through", "base", "contextThrough", "cursor", "cutoff", "expectedSeq"]);

/** The lean expectation of one history: left-out steps and control events removed, sequence numbers renumbered. */
function lean(sequence: Sequence): { steps: { command: Command; expect: Step["expect"]; store?: Step["store"] }[]; maps: KeptMaps } {
  const leftOut: number[] = [];
  for (const step of sequence.steps) {
    if ("error" in step.expect) continue;
    for (const event of step.expect.events) if (step.leftOut || event.data.kind.startsWith("control.")) leftOut.push(event.seq);
  }
  const renumber = (n: number) => n - leftOut.filter((s) => s <= n).length;
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "number" && key !== undefined && SEQ_FIELDS.has(key)) return renumber(value);
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
  };
  const t3 = new Map<string, string>();
  const steps = sequence.steps.filter((s) => !s.leftOut).map((step) => {
    const id = t3RunOf(step.command);
    const command = (id !== undefined ? { ...step.command, providerRunId: id } : step.command) as Command;
    if ("error" in step.expect) return { command, expect: step.expect, ...(step.store ? { store: step.store } : {}) };
    const events = step.expect.events.filter((e) => !e.data.kind.startsWith("control.")).map((original) => {
      const event = walk(original) as RoomEvent & { data: Record<string, unknown> };
      if (event.data.kind === "request") {
        assert.equal(event.data.live, null, `${sequence.name}: a live request in a golden history`);
        delete event.data.live;
      }
      if (event.data.kind === "run.phase" && id !== undefined) {
        event.data.providerRunId = id;
        t3.set(event.data.runId as string, id);
      }
      if (event.data.kind === "sync.offered") assert.ok(leftOut.every((s) => s > event.seq), `${sequence.name}: a sync after a left-out event needs its digest recomputed`);
      return event;
    });
    return { command, expect: { outcome: step.expect.outcome, expectedSeq: renumber(step.expect.expectedSeq), events }, ...(step.store ? { store: step.store } : {}) };
  });
  const maps = walk(sequence.maps) as KeptMaps;
  const leftOutKeys = new Set(sequence.steps.filter((s) => s.leftOut).map((s) => JSON.stringify([s.command.actor, s.command.id])));
  maps.commandKeys = maps.commandKeys.filter((key) => !leftOutKeys.has(key));
  for (const [, seat] of maps.seats) if (seat.status === "stopping") seat.status = "active";
  for (const [, request] of maps.requests) {
    assert.equal(request.live, null);
    delete request.live;
  }
  for (const [id, run] of maps.runs) if (t3.has(id)) run.providerRunId = t3.get(id);
  return { steps, maps: plain(maps) };
}

function outcomeOf(run: () => Decision): Step["expect"] {
  try {
    const d = run();
    return { outcome: d.outcome, expectedSeq: d.expectedSeq, events: plain(d.events) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

let histories = 0;
let leftOutHistories = 0;
for (const file of files) {
  const golden = JSON.parse(readFileSync(join(dir, file), "utf8")) as { source: string; core: string; sequences: Sequence[] };
  test(`golden ${file}: every history replays with equal decisions and kept maps (${golden.sequences.length} histories from ${golden.source})`, () => {
    assert.equal(golden.core, "24961b1");
    for (const sequence of golden.sequences) {
      histories += 1;
      if (sequence.steps.some((s) => s.leftOut)) leftOutHistories += 1;
      const want = lean(sequence);
      // Through `decide` over a plain journal, and through the store the host uses.
      let log: RoomEvent[] = [];
      const store = new EngineStore(":memory:");
      try {
        for (const [index, step] of want.steps.entries()) {
          const at = `${sequence.name} step ${index + 1} (${step.command.type} ${step.command.id})`;
          const got = outcomeOf(() => decide(log, step.command));
          assert.equal(canonical(got), canonical(step.expect), at);
          if (!("error" in got)) log = [...log, ...got.events];
          const stored = outcomeOf(() => {
            const receipt = store.execute("golden", step.command);
            return receipt.replayed ? { ...receipt, outcome: "duplicate" as const, events: [] } : receipt;
          });
          // The store's own checks refuse a few commands `decide` takes (recorded in `store`); a replayed command
          // returns its original batch, which `decide` calls a duplicate.
          if (step.store && "error" in step.store) assert.deepEqual(stored, { error: step.store.error }, `${at} (store)`);
          else if (step.store) assert.equal("outcome" in stored && stored.outcome, step.store.outcome === "replayed" ? "duplicate" : step.store.outcome, `${at} (store)`);
          else if (!("error" in got) && got.outcome === "duplicate") assert.ok("events" in stored && stored.events.length === 0, `${at} (store)`);
          else assert.equal(canonical(stored), canonical(got), `${at} (store)`);
        }
        assert.equal(canonical(keptMaps(fold(log))), canonical(want.maps), `${sequence.name}: kept maps`);
        assert.equal(canonical(keptMaps(store.project("golden"))), canonical(want.maps), `${sequence.name}: kept maps (store)`);
        assert.equal(canonical(store.load("golden")), canonical(log), `${sequence.name}: events`);
      } finally {
        store.close();
      }
    }
  });
}

test("the goldens cover every history recorded, including those with a left-out control", () => {
  assert.equal(histories, 228);
  assert.equal(leftOutHistories, 13);
});
