/**
 * Preload that records golden sequences from the core as merged (L6 step 1). Every `decide` call and every
 * `EngineStore.execute` a test makes is written as one line to $GOLDEN_RAW/$GOLDEN_SOURCE.jsonl: the room's state before
 * (a chained digest of its journal), the command, and the state after (null when nothing was appended). generate.ts
 * rebuilds each room's history from these lines and replays it.
 *
 *   GOLDEN_RAW=<dir> GOLDEN_SOURCE=domain node --import ./tests/engine/golden/record.ts tests/engine/domain.test.ts
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import type { Command, CommitReceipt, Decision, RoomEvent } from "../../../src/engine/index.ts";
import { stateOf } from "./digest.ts";

const raw = process.env.GOLDEN_RAW;
const sourceName = process.env.GOLDEN_SOURCE;
if (!raw || !sourceName) throw new Error("golden recorder: GOLDEN_RAW and GOLDEN_SOURCE are required");
mkdirSync(raw, { recursive: true });
const file = join(raw, `${sourceName}.jsonl`);

register("./record-hooks.ts", import.meta.url);
const { EngineStore } = await import("../../../src/engine/store.ts");

function write(line: { via: "decide" | "store"; before: string; after: string | null; command: Command; outcome?: string; error?: string }): void {
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

(globalThis as { goldenRecord?: unknown }).goldenRecord = (_via: string, log: readonly RoomEvent[], command: Command, decision: Decision | undefined, failure: unknown) => {
  const before = stateOf(log);
  if (decision === undefined) {
    write({ via: "decide", before, after: null, command, error: failure instanceof Error ? failure.message : String(failure) });
    return;
  }
  write({ via: "decide", before, after: decision.events.length ? stateOf([...log, ...decision.events]) : null, command, outcome: decision.outcome });
};

type Store = InstanceType<typeof EngineStore>;
const execute = EngineStore.prototype.execute;
EngineStore.prototype.execute = function recordedExecute(this: Store, room: string, command: Command): CommitReceipt {
  const committed = (): readonly RoomEvent[] => {
    const cache = (this as unknown as { caches: Map<string, { p: { events: readonly RoomEvent[] } }> }).caches.get(room);
    return cache ? cache.p.events : this.load(room);
  };
  let receipt: CommitReceipt;
  try {
    receipt = execute.call(this, room, command);
  } catch (error) {
    try {
      write({ via: "store", before: stateOf(this.load(room)), after: null, command, error: error instanceof Error ? error.message : String(error) });
    } catch {
      // A closed or faulted store has no state to read; the line is skipped.
    }
    throw error;
  }
  try {
    const events = committed();
    if (receipt.replayed) write({ via: "store", before: stateOf(events), after: null, command, outcome: "replayed" });
    else write({ via: "store", before: stateOf(events, receipt.expectedSeq), after: receipt.events.length ? stateOf(events, receipt.expectedSeq + receipt.events.length) : null, command, outcome: receipt.outcome });
  } catch {
    // As above.
  }
  return receipt;
};
