import { existsSync, writeFileSync } from "node:fs";
import { EngineStore } from "../../src/engine/store.ts";
import { canonicalJSON } from "../../src/engine/result.ts";
import { hash } from "../../src/engine/provider.ts";
import type { ActivityPacket, LocalOperationPacket } from "../../src/engine/operation-types.ts";
import type { Command } from "../../src/engine/types.ts";

export type OperationWorkerInput = { path: string; room: string; fault?: string; marker?: string;
  ready?: string; go?: string; holdReady?: string; holdGo?: string } & (
  | { action: "operation"; packet: LocalOperationPacket }
  | { action: "activity"; packet: ActivityPacket }
  | { action: "command"; command: Command }
  | { action: "rebuild" }
);
const input = JSON.parse(process.argv[2]!) as OperationWorkerInput;
function waitFor(path: string): void {
  const end = Date.now() + 8000;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error("operation worker barrier timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
let store: EngineStore | undefined;
try {
  store = new EngineStore(input.path, { onBoundary(point, eventIndex) {
    const label = point === "after_event" ? `${point}:${eventIndex}` : point;
    if (label === input.fault) {
      if (input.marker) writeFileSync(input.marker, label);
      process.kill(process.pid, "SIGKILL");
    }
    if (point === "after_read" && input.holdReady && input.holdGo) {
      writeFileSync(input.holdReady, "serialized writer lock held"); waitFor(input.holdGo);
    }
  } });
  if (input.ready) writeFileSync(input.ready, "connection open");
  if (input.go) waitFor(input.go);
  if (input.action === "operation" || input.action === "activity") {
    // Only validated packets/capability fingerprints cross this trusted store boundary;
    // no bearer secret or caller-provided trust flag enters child arguments or logs.
    const result = input.action === "operation" ? store.commitOperation(input.room, input.packet)
      : store.commitActivity(input.room, input.packet);
    process.stdout.write(JSON.stringify({ ok: true, replayed: result.replayed, receiptKey: result.receipt.key,
      responseJSON: result.receipt.responseJSON, packetDigest: hash(canonicalJSON(result.receipt.packet)) }));
  } else if (input.action === "command") {
    const result = store.execute(input.room, input.command);
    process.stdout.write(JSON.stringify({ ok: true, head: result.head }));
  } else {
    store.rebuild(input.room); process.stdout.write(JSON.stringify({ ok: true }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally { store?.close(); }
