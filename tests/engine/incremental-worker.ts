import { existsSync, writeFileSync } from "node:fs";
import { EngineStore } from "../../src/engine/index.ts";
import type { WorkerInput } from "./store-fixture.ts";

export interface IncrementalWorkerInput extends WorkerInput {
  warm?: boolean;
}
const input = JSON.parse(process.argv[2]!) as IncrementalWorkerInput;
function waitFor(path: string): void {
  const end = Date.now() + 8000;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`incremental worker barrier timed out: ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
let store: EngineStore | undefined, armed = false;
try {
  store = new EngineStore(input.path, { onBoundary(point, index) {
    const label = point === "after_event" ? `${point}:${index}` : point;
    if (armed && label === input.fault) {
      if (input.marker) writeFileSync(input.marker, label);
      process.kill(process.pid, "SIGKILL");
    }
  } });
  if (input.warm) store.project(input.room);
  if (input.ready) writeFileSync(input.ready, "connection warmed");
  if (input.go) waitFor(input.go);
  armed = true;
  const receipt = store.execute(input.room, input.command);
  process.stdout.write(JSON.stringify({ ok: true, receipt }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally { store?.close(); }
